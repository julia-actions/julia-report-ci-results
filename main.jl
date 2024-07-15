import TestItemRunner2, JSON, GitHubActions, StringBuilders
using TestItemRunner2: URI, TestrunResult, TestrunResultDefinitionError, TestrunResultTestitem, TestrunResultTestitemProfile, TestrunResultMessage
using GitHubActions: add_to_file
using StringBuilders: StringBuilder

results_path = ENV["RESULTS_PATH"]

json_files_content = [JSON.parsefile(joinpath(results_path, i)) for i in readdir(results_path)]

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
