import TestItemRunner2, JSON, GitHubActions
using TestItemRunner2: URI, TestrunResult, TestrunResultDefinitionError, TestrunResultTestitem, TestrunResultTestitemProfile, TestrunResultMessage
using GitHubActions: add_to_file

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

results = TestrunResult(
    TestrunResultDefinitionError[],
    [
        (
            [
                TestrunResultTestitem(
                    j["name"],
                    convert_to_uri(j["uri"]),
                    [
                        TestrunResultTestitemProfile(
                            l["profile_name"],
                            Symbol(l["status"]),
                            l["duration"],
                            haskey(j, "messages") ?
                                [
                                    TestrunResultMessage(
                                        k["message"],
                                        convert_to_uri(k["uri"]),
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

o = IOBuffer()

println(o, "# Test summary")
println(o, "$(length(results.testitems)) testitems were run.")
println(o, "## Detailed testitem output")
for ti in results.testitems
    println(o, "### $(ti.name) in $(ti.uri)")
    for tp in ti.profiles
        println(o, "Result on $(tp.profile_name) is $(tp.status)")
    end
end

add_to_file("GITHUB_STEP_SUMMARY", String(take!(o)))

exit(1)
