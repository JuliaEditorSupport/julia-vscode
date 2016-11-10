function get_line(tdpp::TextDocumentPositionParams, server::LanguageServer)
    doc = server.documents[tdpp.textDocument.uri]
    s = tdpp.position.line
    n = length(doc)
    cnt = 0
    i = 0
    while cnt<s && i<n
        i+=1
        if doc[i]==0x0a
            cnt+=1
        end
    end
    io = IOBuffer(doc)
    seek(io,i)
    return String(chomp(readuntil(io,'\n')))
end

function get_word(p::TextDocumentPositionParams, server::LanguageServer, offset=0)
    line = get_line(p, server)
    s = e = max(1,p.position.character)+offset
    while e<=length(line) && Lexer.is_identifier_char(line[e])
        e+=1
    end
    while s>0 && (Lexer.is_identifier_char(line[s]) || line[s]=='.')
        s-=1
    end
    ret = line[s+1:e-1]
    ret =="" && (return "")
    ret = ret[1] == '.' ? ret[2:end] : ret
    return ret 
end

function get_sym(str::String)
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

get_sym(p::TextDocumentPositionParams, server::LanguageServer) = get_sym(get_word(p, server))

function get_docs(x)
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

get_docs(tdpp::TextDocumentPositionParams, server::LanguageServer) = get_docs(get_sym(tdpp, server))

function get_rangelocs(d::Array{UInt8},range::Range)
    (s,e) = (range.start.line, range.end.line)
    n = length(d) 
    cnt = 0 
    i = 0 
    while cnt<s && i<n  
        i+=1 
        if d[i]==0x0a
            cnt+=1 
        end 
    end 
    startline = i 
    while cnt<e && i<n  
        i+=1 
        if d[i]==0x0a
            cnt+=1 
        end 
    end 
    endline = i 
    return startline,endline 
end