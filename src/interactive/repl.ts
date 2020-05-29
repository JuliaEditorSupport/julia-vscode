import * as vscode from 'vscode';
import * as rpc from 'vscode-jsonrpc';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import * as vslc from 'vscode-languageclient';
import * as settings from '../settings';
import * as juliaexepath from '../juliaexepath';
import {generatePipeName, inferJuliaNumThreads} from '../utils';
import * as telemetry from '../telemetry';
import * as jlpkgenv from '../jlpkgenv';
import * as fs from 'async-file';
import { Subject } from 'await-notify';

import * as results from './results'
import * as plots from './plots'
import * as workspace from './workspace'
import * as modules from './modules'

let g_context: vscode.ExtensionContext = null;
let g_settings: settings.ISettings = null;
let g_languageClient: vslc.LanguageClient = null;

let g_terminal: vscode.Terminal = null

let g_connection: rpc.MessageConnection = undefined;

function startREPLCommand() {
    telemetry.traceEvent('command-startrepl');

    startREPL(false);
}

function is_remote_env(): boolean {
    return typeof vscode.env.remoteName !== 'undefined'
}

function get_editor(): string {
    if (is_remote_env() || process.platform == 'darwin') {
        let cmd = vscode.env.appName.includes("Insiders") ? "code-insiders" : "code"
        return `"${path.join(vscode.env.appRoot, "bin", cmd)}"`
    }
    else {
        return `"${process.execPath}"`
    }
}

async function startREPL(preserveFocus: boolean) {
    if (g_terminal == null) {
        let pipename = generatePipeName(process.pid.toString(), 'vsc-julia-repl');

        let juliaIsConnectedPromise = startREPLMsgServer(pipename);

        let args = path.join(g_context.extensionPath, 'scripts', 'terminalserver', 'terminalserver.jl')
        let exepath = await juliaexepath.getJuliaExePath();
        let pkgenvpath = await jlpkgenv.getEnvPath();
        if (pkgenvpath==null) {
            let jlarg1 = ['-i','--banner=no'].concat(vscode.workspace.getConfiguration("julia").get("additionalArgs"))
            let jlarg2 = [
                args,
                pipename,
                vscode.workspace.getConfiguration("julia").get("useRevise").toString(),
                vscode.workspace.getConfiguration("julia").get("usePlotPane").toString(),
                telemetry.getCrashReportingPipename()
            ]
            g_terminal = vscode.window.createTerminal(
                {
                    name: "julia",
                    shellPath: exepath,
                    shellArgs: jlarg1.concat(jlarg2),
                    env: {
                        JULIA_EDITOR: get_editor(),
                        JULIA_NUM_THREADS: inferJuliaNumThreads()
                    }});
        }
        else {
            let env_file_paths = await jlpkgenv.getProjectFilePaths(pkgenvpath);

            let sysImageArgs = [];
            if (vscode.workspace.getConfiguration("julia").get("useCustomSysimage") && env_file_paths.sysimage_path && env_file_paths.project_toml_path && env_file_paths.manifest_toml_path) {
                let date_sysimage = await fs.stat(env_file_paths.sysimage_path);
                let date_manifest = await fs.stat(env_file_paths.manifest_toml_path);

                if (date_sysimage.mtime > date_manifest.mtime) {
                    sysImageArgs = ['-J', env_file_paths.sysimage_path]
                }
                else {
                    vscode.window.showWarningMessage('Julia sysimage for this environment is out-of-date and not used for REPL.')
                }
            }
            let jlarg1 = ['-i', '--banner=no', `--project=${pkgenvpath}`].concat(sysImageArgs).concat(vscode.workspace.getConfiguration("julia").get("additionalArgs"))
            let jlarg2 = [
                args,
                pipename,
                vscode.workspace.getConfiguration("julia").get("useRevise").toString(),
                vscode.workspace.getConfiguration("julia").get("usePlotPane").toString(),
                telemetry.getCrashReportingPipename()
            ]
            g_terminal = vscode.window.createTerminal(
                {
                    name: "julia",
                    shellPath: exepath,
                    shellArgs: jlarg1.concat(jlarg2),
                    env: {
                        JULIA_EDITOR: get_editor(),
                        JULIA_NUM_THREADS: inferJuliaNumThreads()
                    }});
        }
        g_terminal.show(preserveFocus);
        await juliaIsConnectedPromise.wait();
    }
    else {
        g_terminal.show(preserveFocus);
    }
    workspace.setTerminal(g_terminal)
}

function debuggerRun(code: string) {
    let x = {
        type:'julia',
        request: 'attach',
        name: 'Julia REPL',
        code: code,
        stopOnEntry: false
    }
    vscode.debug.startDebugging(undefined, x);
}

function debuggerEnter(code: string) {
    let x = {
        type:'julia',
        request: 'attach',
        name: 'Julia REPL',
        code: code,
        stopOnEntry: true
    }
    vscode.debug.startDebugging(undefined, x);
}

const requestTypeReplRunCode = new rpc.RequestType<{
    filename: string,
    line: number,
    column: number,
    code: string,
    module: string,
    showCodeInREPL: boolean,
    showResultInREPL: boolean
}, void, void, void>('repl/runcode');

const notifyTypeDisplay = new rpc.NotificationType<{kind: string, data: any}, void>('display');
const notifyTypeDebuggerEnter = new rpc.NotificationType<string, void>('debugger/enter');
const notifyTypeDebuggerRun = new rpc.NotificationType<string, void>('debugger/run');
const notifyTypeReplStartDebugger = new rpc.NotificationType<string, void>('repl/startdebugger');

const _onInit = new vscode.EventEmitter<rpc.MessageConnection>()
export const onInit = _onInit.event
const _onExit = new vscode.EventEmitter<Boolean>()
export const onExit = _onExit.event

// code execution start

function startREPLMsgServer(pipename: string) {
    let connected = new Subject();

    let server = net.createServer((socket: net.Socket) => {
        socket.on('close', hadError => {
            _onExit.fire(hadError)
            server.close()
        });

        g_connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(socket),
            new rpc.StreamMessageWriter(socket)
            );

        g_connection.onNotification(notifyTypeDisplay, plots.displayPlot);
        g_connection.onNotification(notifyTypeDebuggerRun, debuggerRun);
        g_connection.onNotification(notifyTypeDebuggerEnter, debuggerEnter);

        g_connection.listen();

        _onInit.fire(g_connection)

        connected.notify();
    });

    server.listen(pipename);

    return connected;
}

async function executeFile(uri?: vscode.Uri) {
    telemetry.traceEvent('command-executejuliafileinrepl');
    let module = 'Main'
    let path = "";
    let code = "";
    if (uri) {
        path = uri.fsPath;
        const readBytes = await vscode.workspace.fs.readFile(uri);
        code = Buffer.from(readBytes).toString('utf8');
    }
    else {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        path = editor.document.fileName;
        code = editor.document.getText();

        module = await modules.getModuleForEditor(editor, new vscode.Position(0, 0))
    }

    await g_connection.sendRequest(
        requestTypeReplRunCode,
        {
            filename: path,
            line: 0,
            column: 0,
            module: module,
            code: code,
            showCodeInREPL: false,
            showResultInREPL: false
        }
    )
}

async function selectJuliaBlock() {
    if (g_languageClient == null) {
        vscode.window.showErrorMessage('Error: Language server is not running.');
    }
    else {
        var editor = vscode.window.activeTextEditor;
        let params: TextDocumentPositionParams = { textDocument: vslc.TextDocumentIdentifier.create(editor.document.uri.toString()), position: new vscode.Position(editor.selection.start.line, editor.selection.start.character) }

        try {
            let ret_val: vscode.Position[] = await g_languageClient.sendRequest('julia/getCurrentBlockRange', params);

            let start_pos = new vscode.Position(ret_val[0].line, ret_val[0].character)
            let end_pos = new vscode.Position(ret_val[1].line, ret_val[1].character)
            vscode.window.activeTextEditor.selection = new vscode.Selection(start_pos, end_pos)
            vscode.window.activeTextEditor.revealRange(new vscode.Range(start_pos, end_pos))
        }
        catch (ex) {
            if (ex.message == "Language client is not ready yet") {
                vscode.window.showErrorMessage('Select code block only works once the Julia Language Server is ready.');
            }
            else {
                throw ex;
            }
        }
    }
}

async function executeJuliaCellInRepl(shouldMove: boolean = false) {
    telemetry.traceEvent('command-executejuliacellinrepl');

    let ed = vscode.window.activeTextEditor;
    let doc = ed.document;
    const section = vscode.workspace.getConfiguration('julia')
    const _regexes: Array<string> = section.get('execution.cellDelimiters')
    const regexes = _regexes.map(s => new RegExp(s))
    let start = doc.validatePosition(ed.selection.active).line;
    while (start >= 0) {
        const text = doc.lineAt(start).text
        if (regexes.some(regex => regex.test(text))) {
            break;
        } else {
            start -= 1;
        }
    }
    start += 1;
    let end = start;
    while (end < doc.lineCount) {
        const text = doc.lineAt(end).text
        if (regexes.some(regex => regex.test(text))) {
            break;
        } else {
            end += 1;
        }
    }
    end -= 1;
    const startpos = new vscode.Position(start, 0);
    const endpos = new vscode.Position(end, doc.lineAt(end).text.length);
    const nextpos = new vscode.Position(end + 1, 0);
    const code = doc.getText(new vscode.Range(startpos, endpos));

    const module: string = await modules.getModuleForEditor(ed, startpos)

    await evaluate(ed, new vscode.Range(startpos, endpos), code, module)

    vscode.window.activeTextEditor.selection = new vscode.Selection(nextpos, nextpos)
    vscode.window.activeTextEditor.revealRange(new vscode.Range(nextpos, nextpos))
}

async function evaluateBlockOrSelection (shouldMove: boolean = false) {
    const editor = vscode.window.activeTextEditor
    const editorId = vslc.TextDocumentIdentifier.create(editor.document.uri.toString());

    for (const selection of editor.selections) {
        let range: vscode.Range = null
        let nextBlock: vscode.Position = null
        const startpos: vscode.Position = new vscode.Position(selection.start.line, selection.start.character)
        const params: TextDocumentPositionParams = {
            textDocument: editorId,
            position: startpos
        }

        const module: string = await modules.getModuleForEditor(editor, startpos)

        if (selection.isEmpty) {
            const currentBlock: vscode.Position[] = await g_languageClient.sendRequest('julia/getCurrentBlockRange', params);
            range = new vscode.Range(currentBlock[0].line, currentBlock[0].character, currentBlock[1].line, currentBlock[1].character)
            nextBlock = new vscode.Position(currentBlock[2].line, currentBlock[2].character)
        } else {
            range = new vscode.Range(selection.start, selection.end)
        }

        const text = editor.document.getText(range)

        if (shouldMove && nextBlock && selection.isEmpty && editor.selections.length == 1) {
            editor.selection = new vscode.Selection(nextBlock, nextBlock)
            editor.revealRange(new vscode.Range(nextBlock, nextBlock))
        }

        await evaluate(editor, range, text, module)
    }
}

async function evaluate(editor: vscode.TextEditor, range: vscode.Range, text: string, module: string) {
    await startREPL(true);

    const section = vscode.workspace.getConfiguration('julia')
    const resultType: string = section.get('execution.resultType')
    const codeInREPL: boolean = section.get('execution.codeInREPL')

    let r: results.Result = null
    if (resultType !== "REPL") {
        r = results.addResult(editor, range, {
            content: ' ⟳ ',
            isIcon: false,
            hoverContent: '',
            isError: false
        })
    }

    let result: any = await g_connection.sendRequest(
        requestTypeReplRunCode,
        {
            filename: editor.document.fileName,
            line: range.start.line,
            column: range.start.character,
            code: text,
            module: module,
            showCodeInREPL: codeInREPL,
            showResultInREPL: resultType !== "inline"
        }
    )

    if (resultType !== "REPL") {
        const hoverString =  '```\n' + result.all.toString() + '\n```'

        r.setContent({
            content: ' ' + result.inline.toString() + ' ',
            isIcon: false,
            hoverContent: hoverString,
            isError: result.iserr
        })
    }
}

// code execution end

export async function replStartDebugger(pipename: string) {
    await startREPL(true)

    g_connection.sendNotification(notifyTypeReplStartDebugger, pipename);
}

export interface TextDocumentPositionParams {
    textDocument: vslc.TextDocumentIdentifier
    position: vscode.Position
}

let getBlockText = new rpc.RequestType<TextDocumentPositionParams, void, void, void>('julia/getCurrentBlockRange')

export function activate(context: vscode.ExtensionContext, settings: settings.ISettings) {
    g_context = context;
    g_settings = settings;

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.startREPL', startREPLCommand));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCodeInREPL', evaluateBlockOrSelection));
    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCodeInREPLAndMove', () => evaluateBlockOrSelection(true)));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCellInREPL', executeJuliaCellInRepl));
    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCellInREPLAndMove', () => executeJuliaCellInRepl(true)));

    // context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCodeInREPL', executeSelection));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaFileInREPL', executeFile));

    // context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCellInREPL', executeJuliaCellInRepl));

    // context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaBlockInREPL', executeJuliaBlockInRepl));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.selectBlock', selectJuliaBlock));

    vscode.window.onDidCloseTerminal(terminal => {
        if (terminal == g_terminal) {
            g_terminal = null;
            workspace.setTerminal(null)
        }
    })

    results.activate(context);
    plots.activate(context);
    workspace.activate(context);
    modules.activate(context);
}

export function onDidChangeConfiguration(newSettings: settings.ISettings) {
    g_settings = newSettings
}

export function onNewLanguageClient(newLanguageClient: vslc.LanguageClient) {
    g_languageClient = newLanguageClient;
    modules.setLanguageClient(g_languageClient)
}
