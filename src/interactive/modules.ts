import { SeverityLevel } from 'applicationinsights/out/Declarations/Contracts'
import * as vscode from 'vscode'
import * as rpc from 'vscode-jsonrpc'
import * as vslc from 'vscode-languageclient'
import { onSetLanguageClient } from '../extension'
import * as telemetry from '../telemetry'
import { VersionedTextDocumentPositionParams } from './misc'
import { onExit, onInit } from './repl'

let statusBarItem: vscode.StatusBarItem = null
let g_connection: rpc.MessageConnection = null
let g_languageClient: vslc.LanguageClient = null

const manuallySetDocuments = []

const requestTypeGetModules = new rpc.RequestType<void, string[], void, void>('repl/loadedModules')
const requestTypeIsModuleLoaded = new rpc.RequestType<string, boolean, void, void>('repl/isModuleLoaded')

const automaticallyChooseOption = 'Choose Automatically'


export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(ed => updateStatusBarItem(ed)))
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(changeEvent => updateModuleForSelectionEvent(changeEvent)))
    context.subscriptions.push(vscode.commands.registerCommand('language-julia.chooseModule', chooseModule))

    context.subscriptions.push(onSetLanguageClient(languageClient => {
        g_languageClient = languageClient
    }))

    // NOTE:
    // set module status bar item just right of language mode selector
    // ref: language selector has priority `100`:
    // https://github.com/microsoft/vscode/blob/1d268b701376470bc638100fbe17d283404ac559/src/vs/workbench/browser/parts/editor/editorStatus.ts#L534
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
    statusBarItem.command = 'language-julia.chooseModule'
    statusBarItem.text = 'Main'
    statusBarItem.tooltip = 'Choose Current Module'

    onInit(conn => {
        g_connection = conn
        updateStatusBarItem(vscode.window.activeTextEditor)
    })
    onExit(hadError => {
        g_connection = null
        statusBarItem.hide()
    })

    context.subscriptions.push(statusBarItem)
}

export async function getModuleForEditor(document: vscode.TextDocument, position: vscode.Position) {
    let mod = manuallySetDocuments[document.fileName]

    if (mod === undefined) {
        const params: VersionedTextDocumentPositionParams = {
            textDocument: vslc.TextDocumentIdentifier.create(document.uri.toString()),
            version: document.version,
            position: position
        }

        if (position.line > editor.document.lineCount) {
            telemetry.traceTrace({
                message: `getModuleForEditor is about to send a request with an invalid line. Request is asking for line ${position.line}, but doc only has ${editor.document.lineCount} lines.}`,
                severity: SeverityLevel.Error
            })
        }

        try {
            mod = await g_languageClient.sendRequest('julia/getModuleAt', params)
        } catch (err) {
            console.error(err)
            mod = 'Main'
        }
    }

    return mod
}

function isJuliaEditor(editor: vscode.TextEditor = vscode.window.activeTextEditor) {
    return editor && editor.document.languageId === 'julia'
}

async function updateStatusBarItem(editor: vscode.TextEditor) {
    if (isJuliaEditor(editor)) {
        statusBarItem.show()
        await updateModuleForEditor(editor)
    } else {
        statusBarItem.hide()
    }
}

async function updateModuleForSelectionEvent(event: vscode.TextEditorSelectionChangeEvent) {
    const editor = event.textEditor
    await updateStatusBarItem(editor)
}

async function updateModuleForEditor(editor: vscode.TextEditor) {
    let mod = 'Main'
    try {
        mod = await getModuleForEditor(editor.document, editor.selection.start)
    } catch (err) {
        if (g_languageClient) {
            telemetry.handleNewCrashReportFromException(err, 'Extension')
        }
    }

    let loaded = false
    try {
        loaded = await g_connection.sendRequest(requestTypeIsModuleLoaded, mod)
    } catch (err) {
        if (g_connection) {
            telemetry.handleNewCrashReportFromException(err, 'Extension')
        }
    }

    statusBarItem.text = loaded ? mod : '(' + mod + ')'
}

async function chooseModule() {
    let possibleModules = []
    try {
        possibleModules = await g_connection.sendRequest(requestTypeGetModules, null)
    } catch (err) {
        if (g_connection) {
            telemetry.handleNewCrashReportFromException(err, 'Extension')
        } else {
            vscode.window.showInformationMessage('Setting a module requires an active REPL.')
        }
        return
    }

    possibleModules.sort()
    possibleModules.splice(0, 0, automaticallyChooseOption)

    const qpOptions: vscode.QuickPickOptions = {
        placeHolder: 'Select module',
        canPickMany: false
    }
    const mod = await vscode.window.showQuickPick(possibleModules, qpOptions)

    const ed = vscode.window.activeTextEditor
    if (mod === automaticallyChooseOption) {
        delete manuallySetDocuments[ed.document.fileName]
    } else {
        manuallySetDocuments[ed.document.fileName] = mod
    }

    updateStatusBarItem(ed)
}
