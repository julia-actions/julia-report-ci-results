import TestItemRunner2, JSON, GitHubActions
using TestItemRunner2: URI, TestrunResult, TestrunResultDefinitionError, TestrunResultTestitem, TestrunResultTestitemProfile, TestrunResultMessage
using GitHubActions: add_to_file

using Query

results_path = ENV["RESULTS_PATH"]

json_files_content = [JSON.parsefile(joinpath(results_path, i)) for i in readdir(results_path)]

function convert_to_uri(s)
    uri = URI(s)

    regexes = [
        r"\/Users\/runner\/work\/([^\/]*)\/\1\/(.*)",
        r"\/home\/runner\/work\/([^\/]*)\/\1\/(.*)",
        r"\/d\:\/a\/([^\/]*)\/\1\/(.*)"
    ]

    for r in regexes
        m = match(r, uri.path)

        if m!==nothing
            return URI("ourpackage", nothing, "$(m[2])", nothing, nothing)
        end
    end

    return uri
end

function github_uri_from_uri(s, line)
    converted_uri = convert_to_uri(s)

    if converted_uri.scheme == "ourpackage"
        return URI("https", "github.com", "/$(ENV["GITHUB_REPOSITORY"])/blob/$(ENV["GITHUB_SHA"])/$(converted_uri.path)", nothing, isnothing(line) ? nothing : "L$line")
    else
        return s
    end
end

function agnostic_message(s)
    s = chomp(s)
    s = replace(s, "\r\n" => "\n")
    parts = split(s, '\n', limit=2)

    regexes = [
        r"Test Failed at \/Users\/runner\/work\/([^\/]*)\/\1\/(.*)",
        r"Test Failed at \/home\/runner\/work\/([^\/]*)\/\1\/(.*)",
        r"Test Failed at d\:\\a\\([^\/]*)\\\1\\(.*)"
    ]

    for r in regexes
        m = match(r, parts[1])

        if m!==nothing
            return "Test Failed at $(m[1])/$(replace(m[2], '\\'=>'/'))\n$(parts[2])"
        end
    end

    return s
end

function compress_profile_lists(profiles)
    reg = r"Julia (\d*.\d*.\d*)\~(.*)\:(.*)"

    asdf = profiles |>
    @map(match(reg, _)) |>
    @filter(!isnothing(_)) |>
    @map({version=_[1], arch=_[2], os=_[3]}) |>
    @groupby({_.os, _.version}) |>
    @orderby(_.os) |>
    @thenby(_.version) |>
    @map({key(_).os, version=key(_).version * "~" * join(_.arch, "~")}) |>
    @groupby({_.os}) |>
    @orderby(_.os) |>
    @map(key(_).os * " (" * join(_.version, ", ") * ")") |>
    collect
    
    return join(asdf, ", ")
end

# Completely wrong, but good enough for now!
function escape_markdown(s)
    return replace(s, "-" => "\\-", "~" => "\\~")
end

# for i in json_files_content
#     JSON.print(i)
# end

results = TestrunResult(
    TestrunResultDefinitionError[],
    [
        (
            [
                TestrunResultTestitem(
                    j["name"],
                    URI(j["uri"]),
                    [
                        TestrunResultTestitemProfile(
                            l["profile_name"],
                            Symbol(l["status"]),
                            something(l["duration"], missing),
                            l["messages"] !== nothing ?
                                [
                                    TestrunResultMessage(
                                        k["message"],
                                        URI(k["uri"]),
                                        k["line"],
                                        k["column"]
                                    ) for k in l["messages"]
                                ] :
                                missing
                        ) for l in j["profiles"]
                    ]
                ) for j in i["testitems"]
            ] for i in json_files_content
        )...;
    ]
)

# println(results)

grouped_testitems = results.testitems |>
@groupby({_.name, uri=convert_to_uri(_.uri)}) |>
@map(TestrunResultTestitem(key(_).name, key(_).uri, [(_.profiles)...;])) |>
collect

# println(grouped_testitems)

fail_overall = false

o = IOBuffer()

lint_results = JSON.parse(ENV["LINT_RESULTS"])
println(lint_results)

println(o, "# Lint summary")
println(o, "$(length(lint_results)) lint messages were generated.")
for diag in lint_results
    uri = URI(diag["uri"])
    path = convert_to_uri(uri).path
    github_uri = github_uri_from_uri(uri, diag["line"])

    println(o, "## $(diag["severity"]) [$path:$(diag["line"])]($github_uri) from $(diag["source"])")
    println(o, "$(diag["message"])")

    if diag["severity"] == "error"
        global fail_overall = true
    end
end

println(o, "# Test summary")
println(o, "$(length(results.testitems)) testitems were run.")
println(o, "## Detailed testitem output")
for ti in grouped_testitems
    println(o, "### `$(ti.name)` in $(ti.uri.path)")

    if all(tp->tp.status==:passed, ti.profiles)
        println(o, "Passed on all platforms $(escape_markdown(compress_profile_lists(map(j->j.profile_name, ti.profiles)))).")
    else
        grouped_by_status = ti.profiles |>
            @groupby({_.status}) |>
            @map({key(_).status, profiles=_}) |>
            collect

        for i in grouped_by_status
            println(o, "#### $(i.status) on $(escape_markdown(compress_profile_lists(map(j->j.profile_name, i.profiles))))")

            deduplicated_messages = i.profiles |>
                @filter(_.messages!==missing) |>
                @mapmany(_.messages, {_.profile_name, __.uri, __.line, __.message}) |>
                @groupby({uri=convert_to_uri(_.uri), _.line, message=agnostic_message(_.message)}) |>
                @map({key(_)..., profile_names=_.profile_name}) |>
                collect
            
            for msg in deduplicated_messages
                github_uri = github_uri_from_uri(msg.uri, msg.line) # URI("https", "github.com", "/$(ENV["GITHUB_REPOSITORY"])/blob/$(ENV["GITHUB_SHA"])/$(msg.uri.path)", nothing, "L$(msg.line)")
                println(github_uri)
                println(o, "##### [$(msg.uri.path):$(msg.line)]($github_uri) on $(escape_markdown(compress_profile_lists(msg.profile_names)))")
                println(o, "```")
                println(o, msg.message)
                println(o, "```")
            end
        end

        # for tp in ti.profiles
        #     println(o, "#### Result on $(escape_markdown(tp.profile_name)) is $(tp.status)")

        #     if tp.messages!==missing
        #         for msg in tp.messages
        #             println(o, "##### $(msg.uri):$(msg.line)")
        #             println(o, "```")
        #             println(o, msg.message)
        #             println(o, "```")
        #         end
        #     end
        # end

        global fail_overall = true
    end
end

add_to_file("GITHUB_STEP_SUMMARY", String(take!(o)))

if fail_overall
    exit(1)
end
