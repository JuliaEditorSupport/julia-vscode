const stdio_bytes = Ref(0)

const current_request_id = Ref(0)

const orig_stdin  = Ref{IO}()
const orig_stdout = Ref{IO}()
const orig_stderr = Ref{IO}()

const read_stdout = Ref{Base.PipeEndpoint}()
const read_stderr = Ref{Base.PipeEndpoint}()

const capture_stdout = true
const capture_stderr = true

function serve_notebook(pipename; crashreporting_pipename::Union{AbstractString,Nothing}=nothing)
    conn = Sockets.connect(pipename)

    conn_endpoint[] = JSONRPC.JSONRPCEndpoint(conn, conn)

    run(conn_endpoint[])

    try
        orig_stdin[]  = Base.stdin
        orig_stdout[] = Base.stdout
        orig_stderr[] = Base.stderr

        if capture_stdout
            read_stdout[], = Base.redirect_stdout()
            redirect_stdout(JuliaNotebookStdio(Base.stdout, "stdout"))
        end
        if capture_stderr
            read_stderr[], = redirect_stderr()
            redirect_stderr(JuliaNotebookStdio(Base.stderr, "stderr"))
        end
        redirect_stdin(JuliaNotebookStdio(Base.stdin, "stdin"))

        Base.Multimedia.pushdisplay(JuliaNotebookInlineDisplay())

        watch_stdio()

        @info "Julia Kernel started..."

        while true
            msg = JSONRPC.get_next_message(conn_endpoint[])

            if msg["method"] == "runcell"
                params = msg["params"]

                current_request_id[] = params["current_request_id"]
                decoded_msg = params["code"]

                try
                    result = Base.invokelatest(include_string, Main, decoded_msg, "FOO")

                    if result !== nothing
                        Base.display(result)
                    end


                    JSONRPC.send_notification(conn_endpoint[], "runcellsucceeded", Dict{String,Any}("request_id" => current_request_id[]))
                catch err
                    bt = catch_backtrace()

                    if err isa LoadError
                        inner_err = err.error

                        st = stacktrace(bt)

                        error_type = string(typeof(inner_err))
                        error_message_str = sprint(showerror, inner_err)
                        traceback = split(sprint(Base.show_backtrace, bt), '\n')

                        JSONRPC.send_notification(conn_endpoint[], "runcellfailed", Dict{String,Any}("request_id" => current_request_id[], "output" => Dict("ename" => error_type, "evalue" => error_message_str, "traceback" => traceback)))
                    else
                        error("Not clear what this means, but we should probably send a crash report.")
                    end
                end

                flush_all()
            else
                error("Unknown message")
            end
        end

    catch err
        Base.display_error(orig_stderr[], err, catch_backtrace())
        readline()
    end

end