import TestItemRunner2, JSON
using TestItemRunner2: URI, TestrunResult, TestrunResultDefinitionError, TestrunResultTestitem, TestrunResultTestitemProfile, TestrunResultMessage

results_path = ENV["RESULTS_PATH"]

json_files_content = [JSON.parsefile(joinpath(results_path, i)) for i in readdir(results_path)]

x = TestrunResult(
    TestrunResultDefinitionError[],
    [([TestrunResultTestitem(j["name"], URI(j["uri"]), [TestrunResultTestitemProfile(l["name"], Symbol(l["status"], l["duration"], [TestrunResultMessage(k["message"], URI(k["uri"]), k["line"], k["column"]) for k in j["messages"]])) for l in j["profiles"]]) for j in i["testitems"]] for i in json_files_content)...;]
)

println("AND IT IS")
println(x)
