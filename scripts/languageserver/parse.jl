type VarInfo
    t
    doc::String
end

type Block
    uptodate::Bool
    ex::Any
    range::Range
    name::String
    var::VarInfo
    localvar::Dict{String,VarInfo}
    diags::Vector{Diagnostic}
end

function Block(utd, ex, r::Range)
    t, name, doc, lvars = classify_expr(ex)
    ctx = LintContext()
    ctx.lineabs = r.start.line+1
    dl = r.end.line-r.start.line-ctx.line
    Lint.lintexpr(ex, ctx)
    diags = map(ctx.messages) do l
        return Diagnostic(Range(Position(r.start.line+l.line+dl-1, 0), Position(r.start.line+l.line+dl-1, 100)),
                        LintSeverity[string(l.code)[1]],
                        string(l.code),
                        "Lint.jl",
                        l.message) 
    end
    v = VarInfo(t, doc)

    return Block(utd, ex, r, name,v, lvars, diags)
end

function Base.parse(uri::String, server::LanguageServer, updateall=false)
    doc = String(server.documents[uri].data)
    linebreaks = get_linebreaks(doc) 
    n = length(doc.data)
    if doc==""
        server.documents[uri].blocks = []
        return
    end
    i = findfirst(b->!b.uptodate, server.documents[uri].blocks)

    if isempty(server.documents[uri].blocks) || updateall || i==0
        i0 = i1 = 1
        p0 = p1 = Position(0, 0)
        out = Block[]
        i4 = 0
    else
        i4 = findnext(b->b.uptodate, server.documents[uri].blocks,i)
        p0 = p1 = server.documents[uri].blocks[i].range.start
        i0 = i1 = linebreaks[p0.line+1]+p0.character+1
        out = server.documents[uri].blocks[1:i-1]
    end

    while 0 < i1 ≤ n
        (ex,i1) = parse(doc, i0, raise=false)
        p0 = get_pos(i0, linebreaks)
        p1 = get_pos(i1-1, linebreaks)
        if isa(ex, Expr) && ex.head in[:incomplete,:error]
            push!(out,Block(false, ex, Range(p0, Position(p0.line+1, 0))))
            while true
                !(doc[i0] in ['\n','\t',' ']) && break
                i0 += 1
            end
            i0 = i1 = search(doc,'\n',i0)
        else
            push!(out,Block(true,ex,Range(p0,p1)))
            i0 = i1
            if i4>0 && ex==server.documents[uri].blocks[i4].ex
                dl = p0.line - server.documents[uri].blocks[i4].range.start.line
                out = vcat(out,server.documents[uri].blocks[i4+1:end])
                for i  = i4+1:length(out)
                    out[i].range.start.line += dl
                    out[i].range.end.line += dl
                end
                break
            end
        end
    end
    server.documents[uri].blocks = out
    return 
end 



function classify_expr(ex)
    if isa(ex, Expr)
        if ex.head==:macrocall && ex.args[1]==GlobalRef(Core, Symbol("@doc"))
            return classify_expr(ex.args[3])
        elseif ex.head in [:const, :global]
            return classify_expr(ex.args[1])
        elseif ex.head==:function || (ex.head==:(=) && isa(ex.args[1], Expr) && ex.args[1].head==:call)
            return parsefunction(ex)
        elseif ex.head==:macro
            return "macro", ex.args[1].args[1], "", Dict(string(x)=>VarInfo(Any,"macro argument") for x in ex.args[1].args[2:end])
        elseif ex.head in [:abstract, :bitstype, :type, :immutable]
            return parsedatatype(ex)
        elseif ex.head==:module
            return "Module", string(ex.args[2]), "", Dict()
        elseif ex.head == :(=) && isa(ex.args[1], Symbol)
            return "Any", string(ex.args[1]), "", Dict()
        end
    end
    return "Any", "none", "", Dict()
end

function parsefunction(ex)
    (isa(ex.args[1], Symbol) || isempty(ex.args[1].args)) && return "Function", "none", "", Dict()
    name = string(isa(ex.args[1].args[1], Symbol) ? ex.args[1].args[1] : ex.args[1].args[1].args[1])
    lvars = Dict()
    for a in ex.args[1].args[2:end]
        if isa(a, Symbol)
            lvars[string(a)] = VarInfo(Any, "Function argument")
        elseif a.head==:(::)
            if length(a.args)>1
                lvars[string(a.args[1])] = VarInfo(a.args[2], "Function argument")
            else
                lvars[string(a.args[1])] = VarInfo(DataType, "Function argument")
            end
        elseif a.head==:kw
            if isa(a.args[1], Symbol)
                lvars[string(a.args[1])] = VarInfo(Any, "Function keyword argument")
            else
                lvars[string(a.args[1].args[1])] = VarInfo(a.args[1].args[2],"Function keyword argument")
            end 
        elseif a.head==:parameters
            if isa(a.args[1], Symbol)
                lvars[string(a.args[1])] = VarInfo(Any, "Function argument")
            else 
                lvars[string(a.args[1].args[1])] = VarInfo(a.args[1].args[2], "Function Argument")
            end
        end
    end 
    doc = string(ex.args[1])
    return "Function", name, doc, lvars
end


function parsedatatype(ex)
    if ex.head in [:abstract, :bitstype]
        name = string(isa(ex.args[1], Symbol) ? ex.args[1] : ex.args[1].args[1])
        doc = string(ex)
    else
        name = string(isa(ex.args[2], Symbol) ? ex.args[2] : ex.args[2].args[1])
        st = string(isa(ex.args[2], Symbol) ? "Any" : string(ex.args[2].args[1]))
        fields = []
        for a in ex.args[3].args 
            if isa(a, Symbol)
                push!(fields, string(a)=>Any)
            elseif a.head==:(::)
                push!(fields, string(a.args[1])=>length(a.args)==1 ? a.args[1] : a.args[2])
            end
        end
        doc = "$name <: $(st)\n"*prod("  $(f[1])::$(f[2])\n" for f in fields)
    end
    return "DataType", name, doc, Dict()
end

import Base:<, in, intersect
<(a::Position, b::Position) =  a.line<b.line || (a.line≤b.line && a.character<b.character)
function in(p::Position, r::Range)
    (r.start.line < p.line < r.end.line) ||
    (r.start.line == p.line && r.start.character ≤ p.character) ||
    (r.end.line == p.line && p.character ≤ r.end.character)  
end

intersect(a::Range, b::Range) = a.start in b || b.start in a

get_linebreaks(doc) = [0; find(c->c==0x0a, doc.data); length(doc.data)+1]

function get_pos(i0, lb)
    nlb = length(lb)-1
    for l in 1:nlb
        if lb[l] < i0 ≤ lb[l+1]
            return Position(l-1, i0-lb[l]-1)
        end
    end
end

