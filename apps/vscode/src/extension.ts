// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import assert from "node:assert"
import { disableCurrentDirectoryExecutableSearch } from "@cline/shared"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { sendAccountButtonClickedEvent } from "./core/controller/ui/subscribeToAccountButtonClicked"
import { sendChatButtonClickedEvent } from "./core/controller/ui/subscribeToChatButtonClicked"
import { sendHistoryButtonClickedEvent } from "./core/controller/ui/subscribeToHistoryButtonClicked"
import { sendMarketplaceButtonClickedEvent } from "./core/controller/ui/subscribeToMarketplaceButtonClicked"
import { sendMcpButtonClickedEvent } from "./core/controller/ui/subscribeToMcpButtonClicked"
import { sendWorktreesButtonClickedEvent } from "./core/controller/ui/subscribeToWorktreesButtonClicked"
import { WebviewProvider } from "./core/webview"
import { parseProviderId } from "./sdk/model-catalog/provider-id"
import { createClineAPI } from "./exports"
import "./utils/path" // necessary to have access to String.prototype.toPosix
import path from "node:path"
import type { ExtensionContext } from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { vscodeHostBridgeClient } from "@/hosts/vscode/hostbridge/client/host-grpc-client"
import { createStorageContext } from "@/shared/storage/storage-context"
import { readTextFromClipboard, writeTextToClipboard } from "@/utils/env"
import { initialize, tearDown } from "./common"
import { addToCline } from "./core/controller/commands/addToCline"
import { explainWithCline } from "./core/controller/commands/explainWithCline"
import { fixWithCline } from "./core/controller/commands/fixWithCline"
import { improveWithCline } from "./core/controller/commands/improveWithCline"
import { sendAddToInputEvent } from "./core/controller/ui/subscribeToAddToInput"
import { sendShowWebviewEvent } from "./core/controller/ui/subscribeToShowWebview"
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache"
import { migrateOpenAiCompatibleBaseUrlToV1 } from "./core/storage/openai-base-url-migration"
import {
	cleanupMcpMarketplaceCatalogFromGlobalState,
	cleanupOldApiKey,
	migrateCustomInstructionsToGlobalRules,
	migrateTaskHistoryToFile,
	migrateWelcomeViewCompleted,
	migrateWorkspaceToGlobalStorage,
} from "./core/storage/state-migrations"
import { workspaceResolver } from "./core/workspace"
import { findMatchingNotebookCell, getContextForCommand, showWebview } from "./hosts/vscode/commandUtils"
import { abortCommitGeneration, generateCommitMsg } from "./hosts/vscode/commit-message-generator"
import { registerClineOutputChannel } from "./hosts/vscode/hostbridge/env/debugLog"
import {
	disposeVscodeCommentReviewController,
	getVscodeCommentReviewController,
} from "./hosts/vscode/review/VscodeCommentReviewController"
import { DIFF_VIEW_URI_SCHEME, diffContentProvider } from "./hosts/vscode/VscodeDiffContentProvider"
import { EDIT_PREVIEW_URI_SCHEME, editPreviewContentProvider, VscodeEditPreview } from "./hosts/vscode/VscodeEditPreview"
import { VscodeWebviewProvider } from "./hosts/vscode/VscodeWebviewProvider"
import { exportVSCodeStorageToSharedFiles } from "./hosts/vscode/vscode-to-file-migration"
import { ExtensionRegistryInfo } from "./registry"
import { AuthService, LogoutReason } from "./sdk/auth-service"
import { telemetryService } from "./services/telemetry"
import type { RolloutBundleActivation } from "./services/telemetry/rollout-metadata"
import { LG_TASK_URI_PATH, SharedUriHandler, TASK_URI_PATH } from "./services/uri/SharedUriHandler"
import { ShowMessageType } from "./shared/proto/host/window"
import { fileExistsAtPath } from "./utils/fs"

export async function reportRolloutActivation(input: RolloutBundleActivation): Promise<void> {
	await telemetryService.captureRolloutBundleActivated(input)
}

// This method is called when the VS Code extension is activated.
// NOTE: This is VS Code specific - services that should be registered
// for all-platform should be registered in common.ts.
export async function activate(context: vscode.ExtensionContext) {
	const activationStartTime = performance.now()

	// Before anything spawns with the workspace as cwd (rg, git, hooks, MCP).
	disableCurrentDirectoryExecutableSearch()

	// 1. Set up HostProvider for VSCode
	// IMPORTANT: This must be done before any service can be registered
	setupHostProvider(context)

	// 2. Clean up legacy data patterns within VSCode's native storage.
	// Moves workspace→global keys, task history→file, custom instructions→rules, etc.
	// Must run BEFORE the file export so we copy clean state.
	await cleanupLegacyVSCodeStorage(context)

	// 3. One-time export of VSCode's native storage to shared file-backed stores.
	// After this, all platforms (VSCode, CLI, JetBrains) read from ~/.cline/data/.
	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	const storageContext = createStorageContext({ workspacePath })
	await exportVSCodeStorageToSharedFiles(context, storageContext)
	migrateOpenAiCompatibleBaseUrlToV1(storageContext)

	// 4. Register services and perform common initialization
	// IMPORTANT: Must be done after host provider is setup and migrations are complete
	const webview = (await initialize(storageContext)) as VscodeWebviewProvider

	// 5. Register services and commands specific to VS Code
	// Initialize hook discovery cache for performance optimization
	HookDiscoveryCache.getInstance().initialize(
		// biome-ignore lint/suspicious/noExplicitAny: Adapt VSCode ExtensionContext to generic interface
		context as any,
		(dir: string) => {
			try {
				const pattern = new vscode.RelativePattern(dir, "*")
				const watcher = vscode.workspace.createFileSystemWatcher(pattern)
				// Ensure watcher is disposed when extension is deactivated
				context.subscriptions.push(watcher)
				// Adapt VSCode FileSystemWatcher to generic interface
				return {
					onDidCreate: (listener: () => void) => watcher.onDidCreate(listener),
					onDidChange: (listener: () => void) => watcher.onDidChange(listener),
					onDidDelete: (listener: () => void) => watcher.onDidDelete(listener),
					dispose: () => watcher.dispose(),
				}
			} catch {
				return null
			}
		},
		(callback: () => void) => {
			// Adapt VSCode Disposable to generic interface
			const disposable = vscode.workspace.onDidChangeWorkspaceFolders(callback)
			context.subscriptions.push(disposable)
			return disposable
		},
	)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VscodeWebviewProvider.SIDEBAR_ID, webview, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// NOTE: Commands must be added to the internal registry before registering them with VSCode
	const { commands } = ExtensionRegistryInfo

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.PlusButton, async () => {
			const sidebarInstance = WebviewProvider.getInstance()
			telemetryService.captureNewTaskClicked("activity_bar_plus", !!sidebarInstance.controller.task)
			await sidebarInstance.controller.clearTask()
			await sidebarInstance.controller.postStateToWebview()
			await sendChatButtonClickedEvent()
		}),
	)
	context.subscriptions.push(vscode.commands.registerCommand(commands.McpButton, () => sendMcpButtonClickedEvent()))
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.MarketplaceButton, () => sendMarketplaceButtonClickedEvent()),
	)
	// Lucky : notre propre fenetre de reglages (webview cree par l'extension, comme la planete).
	// Independante du systeme d'evenements du webview d'origine qui ne repond pas chez nous.
	let luckySettingsPanel: vscode.WebviewPanel | undefined
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.SettingsButton, () => {
			const nodeFs = require("fs")
			const nodeOs = require("os")
			const nodePath = require("path")
			const webFile = nodePath.join(nodeOs.homedir(), ".config", "deep-research-local", "settings.json")
			const readWeb = (): any => {
				try {
					return JSON.parse(nodeFs.readFileSync(webFile, "utf8"))
				} catch {
					return {}
				}
			}
			const writeWeb = (partial: any) => {
				let cur: any = {}
				try {
					cur = JSON.parse(nodeFs.readFileSync(webFile, "utf8"))
				} catch {}
				const merged = { ...cur, ...partial }
				nodeFs.mkdirSync(nodePath.dirname(webFile), { recursive: true })
				nodeFs.writeFileSync(webFile, JSON.stringify(merged, null, 2))
			}
			const getStore = (): any => {
				try {
					return (WebviewProvider.getInstance() as any)?.controller?.getProviderConfigStore()
				} catch {
					return undefined
				}
			}
			const readCtx = (): number => {
				try {
					const c = getStore()?.read(parseProviderId("ollama"))
					return c && typeof c.contextWindow === "number" && c.contextWindow > 0 ? c.contextWindow : 32768
				} catch {
					return 32768
				}
			}
			const writeCtx = (n: number) => {
				try {
					getStore()?.write(parseProviderId("ollama"), { contextWindow: n })
				} catch (e: any) {
					Logger.log("[Lucky] ecriture contexte impossible: " + (e?.message || e))
				}
			}

			if (luckySettingsPanel) {
				luckySettingsPanel.reveal(vscode.ViewColumn.Active, false)
				return
			}
			luckySettingsPanel = vscode.window.createWebviewPanel(
				"luckySettings",
				"Lucky - Reglages",
				{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
				{ enableScripts: true, retainContextWhenHidden: true },
			)
			luckySettingsPanel.onDidDispose(() => {
				luckySettingsPanel = undefined
			})
			luckySettingsPanel.webview.onDidReceiveMessage((msg: any) => {
				if (!msg) {
					return
				}
				if (msg.type === "setCtx" && typeof msg.value === "number") {
					writeCtx(msg.value)
				} else if (msg.type === "saveWeb" && msg.partial) {
					try {
						writeWeb(msg.partial)
					} catch {}
				}
			})

			const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
			const cspSource = luckySettingsPanel.webview.cspSource
			const CTX_STEPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144]
			const WEB_PARAMS = [
				{ key: "results_per_search", label: "Sources par recherche", min: 1, max: 50, step: 1, def: 8, unit: "" },
				{ key: "max_pages", label: "Pages ouvertes (max)", min: 1, max: 100, step: 1, def: 20, unit: "" },
				{ key: "page_chars", label: "Texte par page", min: 1000, max: 200000, step: 1000, def: 8000, unit: "car" },
				{ key: "fetch_concurrency", label: "Telechargements en parallele", min: 1, max: 32, step: 1, def: 8, unit: "" },
				{ key: "fetch_timeout", label: "Delai par page (timeout)", min: 5, max: 120, step: 1, def: 20, unit: "s" },
				{ key: "max_steps", label: "Etapes de l'agent (max)", min: 1, max: 50, step: 1, def: 12, unit: "" },
				{ key: "num_ctx", label: "Contexte agent de recherche", min: 2048, max: 262144, step: 2048, def: 32768, unit: "tok" },
			]
			const init = { ctx: readCtx(), web: readWeb() }

			const css =
				"*{box-sizing:border-box}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;margin:0;font-size:12px;max-width:640px}" +
				"h1{font-size:16px;margin:0 0 2px;display:flex;align-items:center;gap:8px}" +
				"h2{font-size:11.5px;margin:18px 0 4px;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground)}" +
				".sub{color:var(--vscode-descriptionForeground);margin:0 0 6px;font-size:11px}" +
				".row,.toggle{padding:9px 0;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.25))}" +
				".toggle{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
				".hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}" +
				".lab{display:flex;flex-direction:column;gap:2px}.k{font-weight:600}.hint{color:var(--vscode-descriptionForeground);font-size:10.5px}" +
				".val{color:var(--vscode-descriptionForeground)}.ctl{display:flex;align-items:center;gap:10px}" +
				"input[type=range]{flex:1;accent-color:var(--vscode-focusBorder,#3fb950);height:4px}" +
				".num{width:92px;text-align:right;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:4px 6px}" +
				".unit{color:var(--vscode-descriptionForeground);min-width:26px;font-size:10.5px}" +
				".ticks{display:flex;justify-content:space-between;font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px}" +
				".switch{position:relative;width:38px;height:20px;flex:none}.switch input{opacity:0;width:0;height:0}" +
				".slider{position:absolute;inset:0;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,#555);border-radius:20px;cursor:pointer;transition:.15s}" +
				'.slider:before{content:"";position:absolute;width:14px;height:14px;left:2px;top:2px;background:var(--vscode-foreground);border-radius:50%;transition:.15s}' +
				"input:checked+.slider{background:var(--vscode-focusBorder,#3fb950)}input:checked+.slider:before{transform:translateX(18px);background:#fff}" +
				".on{color:#3fb950;font-weight:600}.off{color:var(--vscode-descriptionForeground)}" +
				".warn{color:#d29922;font-size:10.5px;margin-top:8px}" +
				"#saved{position:fixed;top:12px;right:16px;color:#3fb950;font-size:11px;opacity:0;transition:opacity .2s}"

			const ctxOptions = CTX_STEPS.map((_, i) => '<option value="' + i + '"></option>').join("")
			const webRows = WEB_PARAMS.map(
				(p) =>
					'<div class="row"><div class="hdr"><span class="k">' +
					p.label +
					'</span><span class="val" id="wv_' +
					p.key +
					'"></span></div><div class="ctl"><input type="range" id="wr_' +
					p.key +
					'" min="' +
					p.min +
					'" max="' +
					p.max +
					'" step="' +
					p.step +
					'"><input type="number" class="num" id="wn_' +
					p.key +
					'" min="' +
					p.min +
					'" max="' +
					p.max +
					'" step="' +
					p.step +
					'">' +
					(p.unit ? '<span class="unit">' + p.unit + "</span>" : "") +
					"</div></div>",
			).join("")

			const scriptJs =
				"var vscode=acquireVsCodeApi();var CTX=" +
				JSON.stringify(CTX_STEPS) +
				";var WP=" +
				JSON.stringify(WEB_PARAMS) +
				";var INIT=" +
				JSON.stringify(init) +
				";var fT;function flash(){var b=document.getElementById('saved');b.style.opacity='1';clearTimeout(fT);fT=setTimeout(function(){b.style.opacity='0';},900);}" +
				"function nearIdx(v){var b=0;for(var i=1;i<CTX.length;i++){if(Math.abs(CTX[i]-v)<Math.abs(CTX[b]-v))b=i;}return b;}" +
				"var cr=document.getElementById('ctxRange'),cv=document.getElementById('ctxVal');var ci=nearIdx((INIT.ctx)||32768);cr.value=ci;cv.textContent=CTX[ci].toLocaleString()+' tok';" +
				"cr.addEventListener('input',function(){cv.textContent=CTX[parseInt(cr.value,10)].toLocaleString()+' tok';});" +
				"cr.addEventListener('change',function(){var n=CTX[parseInt(cr.value,10)];vscode.postMessage({type:'setCtx',value:n});flash();});" +
				"var webx=INIT.web||{};var en=webx.enabled!==false;var tg=document.getElementById('webEnabled');tg.checked=en;wlbl(en);" +
				"tg.addEventListener('change',function(){wlbl(tg.checked);sw({enabled:tg.checked});});" +
				"function wlbl(x){var e=document.getElementById('webEnabledLabel');e.textContent=x?'ACTIVEE':'coupee';e.className=x?'on':'off';}" +
				"function sw(o){vscode.postMessage({type:'saveWeb',partial:o});flash();}" +
				"function wv(k,d){return (webx[k]!==undefined&&webx[k]!==null)?webx[k]:d;}" +
				"WP.forEach(function(p){var r=document.getElementById('wr_'+p.key),n=document.getElementById('wn_'+p.key),v=document.getElementById('wv_'+p.key),cur=wv(p.key,p.def);r.value=cur;n.value=cur;v.textContent=cur+(p.unit?' '+p.unit:'');" +
				"function commit(x){var m=parseInt(x,10);if(isNaN(m))return;if(m<p.min)m=p.min;if(m>p.max)m=p.max;r.value=m;n.value=m;v.textContent=m+(p.unit?' '+p.unit:'');var o={};o[p.key]=m;sw(o);}" +
				"r.addEventListener('input',function(){n.value=r.value;v.textContent=r.value+(p.unit?' '+p.unit:'');});" +
				"r.addEventListener('change',function(){commit(r.value);});n.addEventListener('change',function(){commit(n.value);});});"

			luckySettingsPanel.webview.html =
				'<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">' +
				"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src " +
				cspSource +
				" 'unsafe-inline'; script-src 'nonce-" +
				nonce +
				"'\">" +
				'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' +
				css +
				"</style></head><body>" +
				'<div id="saved">Enregistre</div>' +
				"<h1>&#127808; Lucky - Reglages</h1>" +
				'<p class="sub">Nos reglages, ecrits directement la ou Lucky les lit. Chaque changement est pris en compte au prochain echange.</p>' +
				"<h2>Modele de chat (Ollama)</h2>" +
				'<div class="row"><div class="hdr"><span class="k">Contexte du modele (crante)</span><span class="val" id="ctxVal"></span></div>' +
				'<input type="range" id="ctxRange" list="ctxSteps" min="0" max="' +
				(CTX_STEPS.length - 1) +
				'" step="1"><datalist id="ctxSteps">' +
				ctxOptions +
				"</datalist>" +
				'<div class="ticks"><span>2k</span><span>16k</span><span>64k</span><span>256k</span></div>' +
				'<p class="warn">Crans : 2k, 4k, 8k, 16k, 32k, 64k, 128k, 256k. Au-dela de ~64k sur une machine de 64 Go, risque de plantage du modele. 32k est le reglage sur.</p></div>' +
				"<h2>Recherche web</h2>" +
				'<div class="toggle"><div class="lab"><span class="k">Recherche web</span><span class="hint">Activer ou couper l\'acces internet</span></div>' +
				'<div class="ctl"><span id="webEnabledLabel"></span><label class="switch"><input type="checkbox" id="webEnabled"><span class="slider"></span></label></div></div>' +
				webRows +
				'<script nonce="' +
				nonce +
				'">' +
				scriptJs +
				"</script></body></html>"
		}),
	)
	context.subscriptions.push(vscode.commands.registerCommand(commands.HistoryButton, () => sendHistoryButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.AccountButton, () => sendAccountButtonClickedEvent()))
	context.subscriptions.push(vscode.commands.registerCommand(commands.WorktreesButton, () => sendWorktreesButtonClickedEvent()))

	// Lucky : panneau de reglages de la recherche web (sliders, webview compact a cote du chat)
	let webSearchPanel: vscode.WebviewPanel | undefined
	context.subscriptions.push(
		vscode.commands.registerCommand("cline.webSearchSettings", async () => {
			const nodeFs = require("fs")
			const nodeOs = require("os")
			const nodePath = require("path")
			const settingsFile = nodePath.join(nodeOs.homedir(), ".config", "deep-research-local", "settings.json")
			const readSettings = (): any => {
				try {
					return JSON.parse(nodeFs.readFileSync(settingsFile, "utf8"))
				} catch {
					return {}
				}
			}
			const writeSettings = (partial: any) => {
				let cur: any = {}
				try {
					cur = JSON.parse(nodeFs.readFileSync(settingsFile, "utf8"))
				} catch {}
				const merged = { ...cur, ...partial }
				nodeFs.mkdirSync(nodePath.dirname(settingsFile), { recursive: true })
				nodeFs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2))
			}

			if (webSearchPanel) {
				webSearchPanel.reveal(vscode.ViewColumn.Beside, false)
				return
			}
			webSearchPanel = vscode.window.createWebviewPanel(
				"luckyWebSearch",
				"Lucky - Recherche web",
				{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
				{ enableScripts: true, retainContextWhenHidden: true },
			)
			webSearchPanel.onDidDispose(() => {
				webSearchPanel = undefined
			})
			webSearchPanel.webview.onDidReceiveMessage((msg: any) => {
				if (msg && msg.type === "save" && msg.partial) {
					try {
						writeSettings(msg.partial)
					} catch {}
				}
			})

			const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
			const cspSource = webSearchPanel.webview.cspSource
			const PARAMS = [
				{ key: "results_per_search", label: "Sources par recherche", hint: "Combien de liens gardes a chaque recherche", min: 1, max: 50, step: 1, def: 8, unit: "" },
				{ key: "max_pages", label: "Pages ouvertes (max)", hint: "Nb total de sites reellement ouverts et lus", min: 1, max: 100, step: 1, def: 20, unit: "" },
				{ key: "page_chars", label: "Texte par page", hint: "Caracteres de texte lus sur chaque page", min: 1000, max: 200000, step: 1000, def: 8000, unit: "car" },
				{ key: "fetch_concurrency", label: "Telechargements en parallele", hint: "Pages chargees en meme temps", min: 1, max: 32, step: 1, def: 8, unit: "" },
				{ key: "fetch_timeout", label: "Delai par page (timeout)", hint: "Secondes avant d'abandonner une page lente", min: 5, max: 120, step: 1, def: 20, unit: "s" },
				{ key: "max_steps", label: "Etapes de l'agent (max)", hint: "Tours de reflexion/action avant de s'arreter", min: 1, max: 50, step: 1, def: 12, unit: "" },
				{ key: "num_ctx", label: "Contexte modele (num_ctx)", hint: "Memoire du modele. Trop haut = crash. 32768 est sur.", min: 2048, max: 262144, step: 2048, def: 32768, unit: "tok" },
			]
			const init = readSettings()
			const rows = PARAMS.map(
				(p) =>
					'<div class="row"><div class="lab"><span class="k">' +
					p.label +
					'</span><span class="hint">' +
					p.hint +
					'</span></div><div class="ctl"><input type="range" id="r_' +
					p.key +
					'" min="' +
					p.min +
					'" max="' +
					p.max +
					'" step="' +
					p.step +
					'"><input type="number" class="num" id="n_' +
					p.key +
					'" min="' +
					p.min +
					'" max="' +
					p.max +
					'" step="' +
					p.step +
					'">' +
					(p.unit ? '<span class="unit">' + p.unit + "</span>" : "") +
					"</div></div>",
			).join("")

			const css =
				"*{box-sizing:border-box}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:14px;margin:0;font-size:12px}" +
				"h1{font-size:15px;margin:0 0 2px;display:flex;align-items:center;gap:8px}.sub{color:var(--vscode-descriptionForeground);margin:0 0 12px;font-size:11px}" +
				".row,.toggle,.modelrow{border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.25));padding:9px 0}" +
				".toggle,.modelrow{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
				".lab{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}.toggle .lab,.modelrow .lab{margin:0}" +
				".k{font-weight:600}.hint{color:var(--vscode-descriptionForeground);font-size:10.5px}" +
				".ctl{display:flex;align-items:center;gap:10px}" +
				"input[type=range]{flex:1;accent-color:var(--vscode-focusBorder,#3f9);height:4px}" +
				".num{width:88px;text-align:right}.num,#model{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:4px 6px}#model{flex:1}" +
				".unit{color:var(--vscode-descriptionForeground);min-width:26px;font-size:10.5px}" +
				".switch{position:relative;width:38px;height:20px;flex:none}.switch input{opacity:0;width:0;height:0}" +
				".slider{position:absolute;inset:0;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,#555);border-radius:20px;cursor:pointer;transition:.15s}" +
				'.slider:before{content:"";position:absolute;width:14px;height:14px;left:2px;top:2px;background:var(--vscode-foreground);border-radius:50%;transition:.15s}' +
				"input:checked+.slider{background:var(--vscode-focusBorder,#3fb950)}input:checked+.slider:before{transform:translateX(18px);background:#fff}" +
				".on{color:#3fb950;font-weight:600}.off{color:var(--vscode-descriptionForeground)}" +
				".warn{color:#d29922;font-size:10.5px;margin-top:10px}#saved{color:#3fb950;font-size:11px;opacity:0;transition:opacity .2s;margin-top:12px;height:14px}"

			const script =
				"const vscode=acquireVsCodeApi();var PARAMS=" +
				JSON.stringify(PARAMS) +
				";var INIT=" +
				JSON.stringify(init) +
				";var fT;function flash(){var b=document.getElementById('saved');b.style.opacity='1';clearTimeout(fT);fT=setTimeout(function(){b.style.opacity='0';},900);}" +
				"function save(o){vscode.postMessage({type:'save',partial:o});flash();}" +
				"function v(k,d){return (INIT[k]!==undefined&&INIT[k]!==null)?INIT[k]:d;}" +
				"var en=INIT.enabled!==false;var tg=document.getElementById('enabled');tg.checked=en;lbl(en);" +
				"tg.addEventListener('change',function(){lbl(tg.checked);save({enabled:tg.checked});});" +
				"function lbl(x){var e=document.getElementById('enabledLabel');e.textContent=x?'ACTIVEE':'coupee';e.className=x?'on':'off';}" +
				"var md=document.getElementById('model');md.value=v('model','');md.addEventListener('change',function(){save({model:md.value});});" +
				"PARAMS.forEach(function(p){var r=document.getElementById('r_'+p.key),n=document.getElementById('n_'+p.key),cur=v(p.key,p.def);r.value=cur;n.value=cur;" +
				"function commit(x){var m=parseInt(x,10);if(isNaN(m))return;if(m<p.min)m=p.min;if(m>p.max)m=p.max;r.value=m;n.value=m;var o={};o[p.key]=m;save(o);}" +
				"r.addEventListener('input',function(){n.value=r.value;});r.addEventListener('change',function(){commit(r.value);});n.addEventListener('change',function(){commit(n.value);});});"

			webSearchPanel.webview.html =
				'<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">' +
				'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' +
				cspSource +
				" 'unsafe-inline'; script-src 'nonce-" +
				nonce +
				"'\">" +
				'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' +
				css +
				"</style></head><body>" +
				"<h1>&#127808; Recherche web</h1>" +
				'<p class="sub">Reglages en direct. Chaque changement est enregistre tout de suite et pris en compte au prochain appel du modele.</p>' +
				'<div class="toggle"><div class="lab"><span class="k">Recherche web</span><span class="hint">Autoriser ou couper l\'acces internet</span></div>' +
				'<div class="ctl"><span id="enabledLabel"></span><label class="switch"><input type="checkbox" id="enabled"><span class="slider"></span></label></div></div>' +
				'<div class="modelrow"><div class="lab"><span class="k">Modele (agent CLI)</span><span class="hint">Modele Ollama pour l\'agent en ligne de commande</span></div>' +
				'<input type="text" id="model" placeholder="ex: qwen3.6-uncensored:35b"></div>' +
				rows +
				'<p class="warn">Astuce : un contexte (num_ctx) trop grand peut faire planter le modele. 32768 est un reglage sur ; monte au-dela seulement si ta machine suit.</p>' +
				'<div id="saved">Enregistre</div>' +
				'<script nonce="' +
				nonce +
				'">' +
				script +
				"</script></body></html>"
		}),
	)

	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))

	// Edit previews use a separate, mutable provider (content set programmatically and
	// re-rendered via onDidChange) so the diff's right side can play the simulated
	// streaming animation. See VscodeEditPreview.
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(EDIT_PREVIEW_URI_SCHEME, editPreviewContentProvider),
	)

	const handleUri = async (uri: vscode.Uri) => {
		const url = decodeURIComponent(uri.toString())
		const uriPath = getUriPath(url)
		const isTaskUri = uriPath === TASK_URI_PATH || uriPath === LG_TASK_URI_PATH

		if (isTaskUri) {
			await openClineSidebarForTaskUri()
		}

		let success = await SharedUriHandler.handleUri(url)

		// Task deeplinks can race with first-time sidebar initialization.
		if (!success && isTaskUri) {
			await openClineSidebarForTaskUri()
			success = await SharedUriHandler.handleUri(url)
		}

		if (!success) {
			Logger.warn("Extension URI handler: Failed to process URI:", uri.toString())
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Debug-harness affordance: VSCode only delivers real vscode:// URIs to the
	// registered handler above, which the harness can't synthesize. When running
	// under browser-capture (debug harness) mode, expose the same handler on
	// globalThis so the harness can deliver simulated OAuth callbacks via
	// `ext.evaluate`. Gated on CLINE_CAPTURE_BROWSER so it never ships in prod.
	if (process.env.CLINE_CAPTURE_BROWSER === "1" || process.env.CLINE_CAPTURE_BROWSER === "true") {
		;(globalThis as Record<string, unknown>).__clineHandleUri = (url: string) => SharedUriHandler.handleUri(url)
	}

	// Register size testing commands in development mode
	if (IS_DEV) {
		vscode.commands.executeCommand("setContext", "cline.isDevMode", IS_DEV)
		// Use dynamic import to avoid loading the module in production
		import("./dev/commands/tasks")
			.then((module) => {
				const devTaskCommands = module.registerTaskCommands(webview.controller)
				context.subscriptions.push(...devTaskCommands)
				Logger.log("[Cline Dev] Dev mode activated & dev commands registered")
			})
			.catch((error) => {
				Logger.log(`[Cline Dev] Failed to register dev commands: ${error}`)
			})
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.TerminalOutput, async () => {
			const terminal = vscode.window.activeTerminal
			if (!terminal) {
				return
			}

			// Save current clipboard content
			const tempCopyBuffer = await readTextFromClipboard()

			try {
				// Copy the *existing* terminal selection (without selecting all)
				await vscode.commands.executeCommand("workbench.action.terminal.copySelection")

				// Get copied content
				const terminalContents = (await readTextFromClipboard()).trim()

				// Restore original clipboard content
				await writeTextToClipboard(tempCopyBuffer)

				if (!terminalContents) {
					// No terminal content was copied (either nothing selected or some error)
					return
				}
				// Ensure the sidebar view is visible but preserve editor focus
				await showWebview(true)

				await sendAddToInputEvent(`Terminal output:\n\`\`\`\n${terminalContents}\n\`\`\``)

				Logger.log("addSelectedTerminalOutputToChat", terminalContents, terminal.name)
			} catch (error) {
				// Ensure clipboard is restored even if an error occurs
				await writeTextToClipboard(tempCopyBuffer)
				Logger.error("Error getting terminal contents:", error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Failed to get terminal contents",
				})
			}
		}),
	)

	// Register code action provider
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			"*",
			new (class implements vscode.CodeActionProvider {
				public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]

				provideCodeActions(
					_document: vscode.TextDocument,
					_range: vscode.Range,
					context: vscode.CodeActionContext,
				): vscode.CodeAction[] {
					// NOTE: These commands must NOT carry `arguments`. Commands with arguments are
					// routed through VS Code's CommandsConverter cache, whose entries are disposed
					// when the code action list is disposed - executing the action then fails with
					// "Actual command not found, wanted to execute ...". The handlers recover the
					// range (selection, expanded around the cursor when empty) and intersecting
					// diagnostics themselves via getContextForCommand.
					const actions: vscode.CodeAction[] = []

					// Add to Lucky (Always available)
					const addAction = new vscode.CodeAction("Add to Lucky", vscode.CodeActionKind.QuickFix)
					addAction.command = {
						command: commands.AddToChat,
						title: "Add to Lucky",
					}
					actions.push(addAction)

					// Explain with Lucky (Always available)
					const explainAction = new vscode.CodeAction("Explain with Lucky", vscode.CodeActionKind.RefactorExtract) // Using a refactor kind
					explainAction.command = {
						command: commands.ExplainCode,
						title: "Explain with Lucky",
					}
					actions.push(explainAction)

					// Improve with Lucky (Always available)
					const improveAction = new vscode.CodeAction("Improve with Lucky", vscode.CodeActionKind.RefactorRewrite) // Using a refactor kind
					improveAction.command = {
						command: commands.ImproveCode,
						title: "Improve with Lucky",
					}
					actions.push(improveAction)

					// Fix with Lucky (Only if diagnostics exist)
					if (context.diagnostics.length > 0) {
						const fixAction = new vscode.CodeAction("Fix with Lucky", vscode.CodeActionKind.QuickFix)
						fixAction.isPreferred = true
						fixAction.command = {
							command: commands.FixWithCline,
							title: "Fix with Lucky",
						}
						actions.push(fixAction)
					}
					return actions
				}
			})(),
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.QuickFix,
					vscode.CodeActionKind.RefactorExtract,
					vscode.CodeActionKind.RefactorRewrite,
				],
			},
		),
	)

	// Register the command handlers
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.AddToChat, async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics)
			if (!context) {
				return
			}
			await addToCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FixWithCline, async (range: vscode.Range, diagnostics: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics)
			if (!context) {
				return
			}
			await fixWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ExplainCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await explainWithCline(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ImproveCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await improveWithCline(context.controller, context.commandContext)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FocusChatInput, async (preserveEditorFocus = false) => {
			const webview = WebviewProvider.getInstance() as VscodeWebviewProvider

			// Show the webview
			const webviewView = webview.getWebview()
			if (webviewView) {
				if (preserveEditorFocus) {
					// Only make webview visible without forcing focus
					webviewView.show(false)
				} else {
					// Show and force focus (default behavior for explicit focus actions)
					webviewView.show(true)
				}
			}

			// Send show webview event with preserveEditorFocus flag
			sendShowWebviewEvent(preserveEditorFocus)
			telemetryService.captureButtonClick("command_focusChatInput", webview.controller?.task?.ulid)
		}),
	)

	// Register Jupyter Notebook command handlers
	const NOTEBOOK_EDIT_INSTRUCTIONS = `Special considerations for using replace_in_file on *.ipynb files:
* Jupyter notebook files are JSON format with specific structure for source code cells
* Source code in cells is stored as JSON string arrays ending with explicit \\n characters and commas
* Always match the exact JSON format including quotes, commas, and escaped newlines.`

	// Helper to get notebook context for Jupyter commands
	async function getNotebookCommandContext(range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) {
		const activeNotebook = vscode.window.activeNotebookEditor
		if (!activeNotebook) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "No active Jupyter notebook found. Please open a .ipynb file first.",
			})
			return null
		}

		const ctx = await getContextForCommand(range, diagnostics)
		if (!ctx) {
			return null
		}

		const filePath = ctx.commandContext.filePath || ""
		let cellJson: string | null = null
		if (activeNotebook.notebook.cellCount > 0) {
			const cellIndex = activeNotebook.notebook.cellAt(activeNotebook.selection.start).index
			cellJson = await findMatchingNotebookCell(filePath, cellIndex)
		}

		return { ...ctx, cellJson }
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterGenerateCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Generate Notebook Cell",
					"Enter your prompt for generating notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
Insert a new Jupyter notebook cell above or below the current cell based on user prompt.
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await addToCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterExplainCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = ctx.cellJson
					? `\n\nCurrent Notebook Cell Context (JSON, sanitized of image data):\n\`\`\`json\n${ctx.cellJson}\n\`\`\``
					: undefined

				await explainWithCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterImproveCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Improve Notebook Cell",
					"Enter your prompt for improving the current notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await improveWithCline(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	// Register the openWalkthrough command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.Walkthrough, async () => {
			await vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#ClineWalkthrough`)
			telemetryService.captureButtonClick("command_openWalkthrough")
		}),
	)

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.GenerateCommit, async (scm) => {
			generateCommitMsg(webview.controller, scm)
		}),
		vscode.commands.registerCommand(commands.AbortCommit, () => {
			abortCommitGeneration()
		}),
	)

	// Listen for secrets changes (cross-window login/logout sync).
	// NOTE: Credentials now live in providers.json (single source of truth).
	// This listener catches legacy secrets.json writes from older windows and
	// triggers a re-read from providers.json via restoreRefreshTokenAndRetrieveAuthInfo().
	const unsubSecrets = storageContext.secrets.onDidChange((event) => {
		if (event.key === "cline:clineAccountId") {
			const secretValue = storageContext.secrets.get<string>(event.key)
			const activeWebview = WebviewProvider.getVisibleInstance()
			const controller = activeWebview?.controller

			const authService = AuthService.getInstance(controller)
			if (secretValue) {
				// Secret was added or updated - restore auth info (login from another window)
				authService?.restoreRefreshTokenAndRetrieveAuthInfo()
			} else {
				// Secret was removed - handle logout for all windows
				authService?.handleDeauth(LogoutReason.CROSS_WINDOW_SYNC)
			}
		}
	})
	context.subscriptions.push({ dispose: unsubSecrets })

	Logger.log(`[Cline] extension activated in ${performance.now() - activationStartTime} ms`)

	return createClineAPI(webview.controller)
}

async function showJupyterPromptInput(title: string, placeholder: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick()
		quickPick.title = title
		quickPick.placeholder = placeholder
		quickPick.ignoreFocusOut = true

		// Allow free text input
		quickPick.canSelectMany = false

		let userInput = ""

		quickPick.onDidChangeValue((value) => {
			userInput = value
			// Update items to show the current input
			if (value) {
				quickPick.items = [
					{
						label: "$(check) Use this prompt",
						detail: value,
						alwaysShow: true,
					},
				]
			} else {
				quickPick.items = []
			}
		})

		quickPick.onDidAccept(() => {
			if (userInput) {
				resolve(userInput)
				quickPick.hide()
			}
		})

		quickPick.onDidHide(() => {
			if (!userInput) {
				resolve(undefined)
			}
			quickPick.dispose()
		})

		quickPick.show()
	})
}

function setupHostProvider(context: ExtensionContext) {
	const outputChannel = registerClineOutputChannel(context)
	outputChannel.appendLine("[Cline] Setting up VS Code host...")

	const createWebview = () => new VscodeWebviewProvider(context)
	const createEditPreview = () => new VscodeEditPreview()
	const createCommentReview = () => getVscodeCommentReviewController()

	const getCallbackUrl = async (path: string, _preferredPort?: number) => {
		const scheme = vscode.env.uriScheme || "vscode"
		const callbackUri = vscode.Uri.parse(`${scheme}://${context.extension.id}${path}`)

		if (vscode.env.uiKind === vscode.UIKind.Web) {
			// In VS Code Web (Codespaces, code serve-web), vscode:// URIs redirect to the
			// desktop app instead of staying in the browser. Use asExternalUri to convert
			// to a web-reachable HTTPS URL that routes back to the extension's URI handler.
			const externalUri = await vscode.env.asExternalUri(callbackUri)
			return externalUri.toString(true)
		}

		// In regular desktop VS Code, use the vscode:// URI protocol handler directly.
		return callbackUri.toString(true)
	}
	HostProvider.initialize(
		createWebview,
		createEditPreview,
		createCommentReview,
		vscodeHostBridgeClient,
		() => {}, // No-op logger, logging is handled via HostProvider.env.debugLog
		getCallbackUrl,
		getBinaryLocation,
		context.extensionUri.fsPath,
		context.globalStorageUri.fsPath,
	)
}

function getUriPath(url: string): string | undefined {
	try {
		return new URL(url).pathname
	} catch {
		return undefined
	}
}

async function openClineSidebarForTaskUri(): Promise<void> {
	const sidebarWaitTimeoutMs = 3000
	const sidebarWaitIntervalMs = 50

	await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)

	const startedAt = Date.now()
	while (Date.now() - startedAt < sidebarWaitTimeoutMs) {
		if (WebviewProvider.getVisibleInstance()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, sidebarWaitIntervalMs))
	}

	Logger.warn("Task URI handling timed out waiting for Cline sidebar visibility")
}

async function getBinaryLocation(name: string): Promise<string> {
	// The only binary currently supported is the rg binary from the VSCode installation.
	if (!name.startsWith("rg")) {
		throw new Error(`Binary '${name}' is not supported`)
	}

	const checkPath = async (pkgFolder: string) => {
		const fullPathResult = workspaceResolver.resolveWorkspacePath(
			vscode.env.appRoot,
			path.join(pkgFolder, name),
			"Services.ripgrep.getBinPath",
		)
		const fullPath = typeof fullPathResult === "string" ? fullPathResult : fullPathResult.absolutePath
		return (await fileExistsAtPath(fullPath)) ? fullPath : undefined
	}

	// VS Code 1.122.0 (microsoft/vscode#317978 et al.) migrated from @vscode/ripgrep
	// to @vscode/ripgrep-universal, which ships per-platform/arch subdirectories.
	// Probe the new layout first; fall back to the legacy paths for ≤1.121.x.
	const platformArch = `${process.platform}-${process.arch}`
	const binPath =
		(await checkPath(`node_modules/@vscode/ripgrep-universal/bin/${platformArch}/`)) ||
		(await checkPath(`node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/${platformArch}/`)) ||
		(await checkPath("node_modules/@vscode/ripgrep/bin/")) ||
		(await checkPath("node_modules/vscode-ripgrep/bin")) ||
		(await checkPath("node_modules.asar.unpacked/vscode-ripgrep/bin/")) ||
		(await checkPath("node_modules.asar.unpacked/@vscode/ripgrep/bin/"))
	if (!binPath) {
		throw new Error("Could not find ripgrep binary")
	}
	return binPath
}

// This method is called when your extension is deactivated
export async function deactivate() {
	// Dispose Non-VSCode-specific services
	try {
		await tearDown()
	} finally {
		// VSCode-specific services
		disposeVscodeCommentReviewController()
	}
}

// TODO: Find a solution for automatically removing DEV related content from production builds.
//  This type of code is fine in production to keep. We just will want to remove it from production builds
//  to bring down built asset sizes.
//
// This is a workaround to reload the extension when the source code changes
// since vscode doesn't support hot reload for extensions
const IS_DEV = process.env.IS_DEV === "true"
const DEV_WORKSPACE_FOLDER = process.env.DEV_WORKSPACE_FOLDER

// Set up development mode file watcher
if (IS_DEV) {
	assert(DEV_WORKSPACE_FOLDER, "DEV_WORKSPACE_FOLDER must be set in development")
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(DEV_WORKSPACE_FOLDER, "src/**/*"))

	watcher.onDidChange(({ scheme, path }) => {
		Logger.info(`${scheme} ${path} changed. Reloading VSCode...`)

		vscode.commands.executeCommand("workbench.action.reloadWindow")
	})
}

// VSCode-specific storage migrations
async function cleanupLegacyVSCodeStorage(context: ExtensionContext): Promise<void> {
	try {
		await cleanupOldApiKey(context)
		// Migrate is not done if the new storage does not have the lastShownAnnouncementId flag
		const hasMigrated = context.globalState.get("lastShownAnnouncementId")
		if (hasMigrated !== undefined) {
			return
		}

		Logger.info("[VS Code Storage Migrations] Starting")

		// Migrate custom instructions to global Cline rules (one-time cleanup)
		await migrateCustomInstructionsToGlobalRules(context)

		// Migrate welcomeViewCompleted setting based on existing API keys (one-time cleanup)
		await migrateWelcomeViewCompleted(context)

		// Migrate workspace storage values back to global storage (reverting previous migration)
		await migrateWorkspaceToGlobalStorage(context)

		// Ensure taskHistory.json exists and migrate legacy state (runs once)
		await migrateTaskHistoryToFile(context)

		// Clean up MCP marketplace catalog from global state (moved to disk cache)
		await cleanupMcpMarketplaceCatalogFromGlobalState(context)

		// lastShownAnnouncementId will be set when announcement is shown
		// after activation so we don't need to set it here.

		Logger.info("[VS Code Storage Migrations] Completed")
	} catch (error) {
		Logger.warn(`[VS Code Storage Migrations] Failed${error instanceof Error ? `: ${error.message}` : ""}`)
	}
}
