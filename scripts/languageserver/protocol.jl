# Position
type Position
    line::Int
    character::Int
end
Position(d::Dict) = Position(d["line"],d["character"])
Position(line) = Position(line,0)
Position() = Position(-1,-1)

let ex=:(type Range
        start::Position
        finish::Position
    end)
    ex.args[3].args=ex.args[3].args[[2;4]]
    ex.args[3].args[2].args[1]=Symbol("end")
    eval(ex)
end

Range(d::Dict) = Range(Position(d["start"]),Position(d["end"]))
Range(line::Integer) = Range(Position(line),Position(line))
Range(line::Integer,character::Integer) = Range(Position(line,character),Position(line,character))

type Location
    uri::String
    range::Range
end
Location(d::Dict) = Location(d["uri"],Range(d["range"]))
Location(f::String,line) = Location(f,Range(line))






# TextDocument

type TextDocumentIdentifier
    uri::String
    TextDocumentIdentifier(d::Dict) = new(d["uri"])
end


type VersionedTextDocumentIdentifier
    uri::String
    version::Int
    VersionedTextDocumentIdentifier(d::Dict) = new(d["uri"],d["version"])
end



# WILL NEED CHANGING
type TextDocumentContentChangeEvent 
    range::Range
    rangeLength::Int
    text::String
end
TextDocumentContentChangeEvent(d::Dict) = TextDocumentContentChangeEvent(Range(d["range"]),d["rangeLength"],d["text"])
# TextDocumentContentChangeEvent(d::Dict) = TextDocumentContentChangeEvent(d["text"])


type DidChangeTextDocumentParams
    textDocument::VersionedTextDocumentIdentifier
    contentChanges::Vector{TextDocumentContentChangeEvent}
    DidChangeTextDocumentParams(d::Dict) = new(VersionedTextDocumentIdentifier(d["textDocument"]),TextDocumentContentChangeEvent.(d["contentChanges"]))
end


type TextDocumentItem
    uri::String
    languageId::String
    version::Int
    text::String
    TextDocumentItem(d::Dict) = new(d["uri"],d["languageId"],d["version"],d["text"])
end


type TextDocumentPositionParams
    textDocument::TextDocumentIdentifier
    position::Position
    TextDocumentPositionParams(d::Dict) = new(TextDocumentIdentifier(d["textDocument"]),Position(d["position"]))
end

type DidOpenTextDocumentParams
    textDocument::TextDocumentItem
    DidOpenTextDocumentParams(d::Dict) = new(TextDocumentItem(d["textDocument"]))
end

type DidCloseTextDocumentParams
    textDocument::TextDocumentIdentifier
    DidCloseTextDocumentParams(d::Dict) = new(TextDocumentIdentifier(d["textDocument"]))
end

type Notification
    jsonrpc::String
    method::String
    params::Any
    Notification(method,params)=new("2.0",method,params)
end



# Messages
abstract Message
abstract Method

type Request{m<:Method,T} <: Message
    id::Int
    params::T
end

const ProviderList = ["textDocument/hover"
                      "textDocument/completion"
                      "textDocument/definition"
                      "textDocument/signatureHelp"
                      "initialize"
                      "textDocument/didOpen"
                      "textDocument/didChange"
                      "textDocument/didClose"
                      "textDocument/didSave" #does nothing
                      "\$/cancelRequest"] #does nothing

function Request(d::Dict)
    m = d["method"]
    if m=="textDocument/hover"
        return Request{hover,TextDocumentPositionParams}(d["id"],TextDocumentPositionParams(d["params"]))
    elseif m=="textDocument/completion"
        return Request{completion,TextDocumentPositionParams}(d["id"],TextDocumentPositionParams(d["params"]))
    elseif m=="textDocument/definition"
        return Request{definition,TextDocumentPositionParams}(d["id"],TextDocumentPositionParams(d["params"]))
    elseif m=="textDocument/signatureHelp"
        return Request{signature,TextDocumentPositionParams}(d["id"],TextDocumentPositionParams(d["params"]))
    elseif m=="initialize"
        return Request{initialize,Any}(d["id"],Any(d["params"]))
    elseif m=="textDocument/didOpen"
        return Request{didOpen,DidOpenTextDocumentParams}(-1,DidOpenTextDocumentParams(d["params"]))
    elseif m=="textDocument/didChange"
        return Request{didChange,DidChangeTextDocumentParams}(-1,DidChangeTextDocumentParams(d["params"]))
    elseif m=="textDocument/didClose"
        info(d)
        return Request{didClose,DidCloseTextDocumentParams}(-1,DidCloseTextDocumentParams(d["params"]))
    end
end

type Response{m<:Method,T} <: Message
    jsonrpc::String
    id::Int
    result::T
end

Respond(t::Void) = nothing




# Utilities
function Line(p::TextDocumentPositionParams)
    d = documents[p.textDocument.uri]
    return d[p.position.line+1]
end

function Word(p::TextDocumentPositionParams,offset=0)
    line = Line(p)
    s = e = max(1,p.position.character)+offset
    while e<=length(line) && Lexer.is_identifier_char(line[e])
        e+=1
    end
    while s>0 && (Lexer.is_identifier_char(line[s]) || line[s]=='.')
        s-=1
    end
    ret = line[s+1:e-1]
    ret = ret[1] == '.' ? ret[2:end] : ret
    return ret 
end

function getSym(str::String)
    name = split(str,'.')
    try
        x = getfield(Main,Symbol(name[1]))
        for i = 2:length(name)
            x = getfield(x,Symbol(name[i]))
        end
        return x
    catch
        return nothing
    end
end

getSym(p::TextDocumentPositionParams) = getSym(Word(p))

function docs(x)
    str = string(Docs.doc(x))
    if str[1:16]=="No documentation"
        s = last(search(str,"\n\n```\n"))+1
        e = first(search(str,"\n```",s))-1
        if isa(x,DataType)
            s1 = last(search(str,"\n\n```\n",e))+1
            e1 = first(search(str,"\n```",s1))-1
            d = vcat(str[s:e], split(str[s1:e1],'\n'))
        elseif isa(x,Function)
            d = split(str[s:e],'\n')
            s = last(search(str,"\n\n"))+1
            e = first(search(str,"\n\n",s))-1
            d = map(dd->(dd = dd[1:first(search(dd," in "))-1]),d)
            d[1] = str[s:e]
        elseif isa(x,Module)
            d = [split(str,'\n')[3]]
        else
            d = [""]
        end
    else
        d = split(str,"\n\n")
    end
    return d
end
docs(tdpp::TextDocumentPositionParams) = docs(getSym(tdpp))
