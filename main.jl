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
            return URI("ourpackage", nothing, "$(m[1])/$(m[2])", nothing, nothing)
        end
    end

    return uri
end

# Completely wrong, but good enough for now!
function escape_markdown(s)
    return replace(s, "-" => "\\-")
end

for i in json_files_content
    JSON.print(i)
end

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
                            l["duration"],
                            haskey(j, "messages") ?
                                [
                                    TestrunResultMessage(
                                        k["message"],
                                        URI(k["uri"]),
                                        k["line"],
                                        k["column"]
                                    ) for k in j["messages"]
                                ] :
                                missing
                        ) for l in j["profiles"]
                    ]
                ) for j in i["testitems"]
            ] for i in json_files_content
        )...;
    ]
)

println(results)

grouped_testitems = results.testitems |>
@groupby({_.name, uri=convert_to_uri(_.uri)}) |>
@map(TestrunResultTestitem(key(_).name, key(_).uri, [(_.profiles)...;])) |>
collect

println(grouped_testitems)

o = IOBuffer()

println(o, "# Test summary")
println(o, "$(length(results.testitems)) testitems were run.")
println(o, "## Detailed testitem output")
for ti in grouped_testitems
    println(o, "### `$(ti.name)` in $(ti.uri.path)")

    if all(tp->tp.status==:passed, ti.profiles)
        println(o, "Passed on all platforms ($(join(map(i->escape_markdown(i.profile_name), ti.profiles), ", "))).")
    else
        for tp in ti.profiles
            println(o, "#### Result on $(escape_markdown(tp.profile_name)) is $(tp.status)")

            if tp.messages!==missing
                for msg in tp.messages
                    println(o, "##### $(msg.uri):$(msg.line)")
                    println(o, msg.message)
                end
            end
        end
    end
end

add_to_file("GITHUB_STEP_SUMMARY", String(take!(o)))

exit(1)
