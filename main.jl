import TestItemRunnerCore, JSON, GitHubActions
using TestItemRunnerCore: URI, TestrunResult, TestrunResultDefinitionError, TestrunResultTestitem, TestrunResultTestitemProfile, TestrunResultMessage, TestrunResultStackFrame
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

    matched = String[]
    unmatched = String[]

    for p in profiles
        m = match(reg, p)
        if m !== nothing
            push!(matched, p)
        else
            push!(unmatched, p)
        end
    end

    parts = String[]

    if !isempty(matched)
        compressed = matched |>
        @map(match(reg, _)) |>
        @map({version=_[1], arch=_[2], os=_[3]}) |>
        @groupby({_.os, _.version}) |>
        @orderby(_.os) |>
        @thenby(_.version) |>
        @map({key(_).os, version=key(_).version * "~" * join(_.arch, "~")}) |>
        @groupby({_.os}) |>
        @orderby(_.os) |>
        @map(key(_).os * " (" * join(_.version, ", ") * ")") |>
        collect
        append!(parts, compressed)
    end

    append!(parts, unique(unmatched))

    return replace(join(parts, ", "), "~" => "\\~")
end

function status_emoji(s::Symbol)
    s == :passed  ? "✅" :
    s == :failed  ? "❌" :
    s == :errored ? "💥" :
    s == :crash   ? "💀" :
    s == :timeout ? "⏱️" : "❓"
end

const STATUS_SEVERITY = Dict(:passed => 0, :failed => 1, :errored => 2, :crash => 3, :timeout => 4)

function worst_status(profiles)
    statuses = map(p -> p.status, profiles)
    return argmax(s -> get(STATUS_SEVERITY, s, 99), statuses)
end

function format_duration(profiles)
    durations = filter(d -> d !== missing, map(p -> p.duration, profiles))
    isempty(durations) && return "—"
    total_ms = sum(durations)
    if total_ms < 1000
        return "$(round(Int, total_ms)) ms"
    elseif total_ms < 60_000
        return "$(round(total_ms / 1000; digits=1)) s"
    else
        return "$(round(total_ms / 60_000; digits=1)) min"
    end
end

function severity_emoji(severity)
    severity == "error"   ? "❌" :
    severity == "warning" ? "⚠️" :
    severity == "info"    ? "ℹ️" : "💡"
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
                                        something(get(k, "expected_output", nothing), missing),
                                        something(get(k, "actual_output", nothing), missing),
                                        URI(k["uri"]),
                                        k["line"],
                                        k["column"],
                                        let sf = get(k, "stack_frames", nothing)
                                            sf === nothing ? missing : TestrunResultStackFrame[
                                                TestrunResultStackFrame(
                                                    f["label"],
                                                    URI(f["uri"]),
                                                    f["line"],
                                                    f["column"],
                                                ) for f in sf
                                            ]
                                        end,
                                    ) for k in l["messages"]
                                ] :
                                missing,
                            something(get(l, "output", nothing), missing)
                        ) for l in j["profiles"]
                    ]
                ) for j in i["testitems"]
            ] for i in json_files_content
        )...;
    ],
    merge(Dict{String,String}(), [Dict{String,String}(k => v for (k, v) in get(i, "process_outputs", Dict())) for i in json_files_content]...)
)

# println(results)

grouped_testitems = results.testitems |>
@groupby({_.name, uri=convert_to_uri(_.uri)}) |>
@map(TestrunResultTestitem(key(_).name, key(_).uri, [(_.profiles)...;])) |>
collect

# Sort so failed/errored test items appear first
sort!(grouped_testitems, by=ti -> get(STATUS_SEVERITY, worst_status(ti.profiles), 99), rev=true)

# println(grouped_testitems)

fail_overall = false

o = IOBuffer()

lint_results = JSON.parse(ENV["LINT_RESULTS"])

# ── Compute aggregate stats ──────────────────────────────────────────────

for diag in lint_results
    if diag["severity"] == "error"
        global fail_overall = true
    end
end

num_testitems = length(grouped_testitems)
num_passed = count(ti -> all(p -> p.status == :passed, ti.profiles), grouped_testitems)
num_failed = num_testitems - num_passed
num_lint   = length(lint_results)

if num_failed > 0
    global fail_overall = true
end

# ── Banner ────────────────────────────────────────────────────────────────

if fail_overall
    println(o, "# ❌ CI Report — Issues Found")
else
    println(o, "# ✅ CI Report — All Checks Passed")
end

stats_parts = String[]
push!(stats_parts, "**$(num_testitems)** test items")
num_passed > 0 && push!(stats_parts, "**$(num_passed)** passed")
num_failed > 0 && push!(stats_parts, "**$(num_failed)** with issues")
num_lint   > 0 && push!(stats_parts, "**$(num_lint)** lint messages")
println(o, "> $(join(stats_parts, " · "))")
println(o)

# ── Lint Results ──────────────────────────────────────────────────────────

if !isempty(lint_results)
    lint_errors   = count(d -> d["severity"] == "error", lint_results)
    lint_warnings = count(d -> d["severity"] == "warning", lint_results)

    lint_summary_parts = String[]
    lint_errors   > 0 && push!(lint_summary_parts, "$(lint_errors) error$(lint_errors == 1 ? "" : "s")")
    lint_warnings > 0 && push!(lint_summary_parts, "$(lint_warnings) warning$(lint_warnings == 1 ? "" : "s")")
    lint_other = num_lint - lint_errors - lint_warnings
    lint_other > 0 && push!(lint_summary_parts, "$(lint_other) info")

    println(o, "<details$(lint_errors > 0 ? " open" : "")>")
    println(o, "<summary><h2>🔍 Lint Results — $(join(lint_summary_parts, ", "))</h2></summary>")
    println(o)
    println(o, "| | Severity | Location | Source | Message |")
    println(o, "|---|---|---|---|---|")
    for diag in lint_results
        uri = URI(diag["uri"])
        path = convert_to_uri(uri).path
        github_uri = github_uri_from_uri(uri, diag["line"])
        emoji = severity_emoji(diag["severity"])
        msg_oneline = replace(diag["message"], "\n" => " ", "|" => "\\|")
        println(o, "| $(emoji) | $(diag["severity"]) | [$(path):$(diag["line"])]($(github_uri)) | $(diag["source"]) | $(msg_oneline) |")
    end
    println(o)
    println(o, "</details>")
    println(o)
end

# ── Test Results Summary Table ────────────────────────────────────────────

println(o, "## 📋 Test Summary")
println(o)
println(o, "| | Test Item | File | Duration | Profiles |")
println(o, "|---|---|---|---|---|")
for ti in grouped_testitems
    ws = worst_status(ti.profiles)
    emoji = status_emoji(ws)
    dur = format_duration(ti.profiles)
    profiles_str = compress_profile_lists(map(p -> p.profile_name, ti.profiles))
    println(o, "| $(emoji) | **$(ti.name)** | $(ti.uri.path) | $(dur) | $(profiles_str) |")
end
println(o)

# ── Detailed Test Output ──────────────────────────────────────────────────

println(o, "## 🔬 Detailed Results")
println(o)
for ti in grouped_testitems
    all_passed = all(tp -> tp.status == :passed, ti.profiles)
    ws = worst_status(ti.profiles)
    emoji = status_emoji(ws)
    open_attr = all_passed ? "" : " open"

    println(o, "<details$(open_attr)>")
    println(o, "<summary>$(emoji) <strong>$(ti.name)</strong> — <code>$(ti.uri.path)</code></summary>")
    println(o)

    if all_passed
        profiles_str = compress_profile_lists(map(p -> p.profile_name, ti.profiles))
        println(o, "> Passed on all profiles: $(profiles_str)")
    else
        passed_profiles = filter(p -> p.status == :passed, ti.profiles)
        failed_profiles = filter(p -> p.status != :passed, ti.profiles)

        # 1) Show passed profiles
        if !isempty(passed_profiles)
            passed_str = compress_profile_lists(map(p -> p.profile_name, passed_profiles))
            println(o, "> ✅ **Passed** on: $(passed_str)")
            println(o, ">")
        end

        # 2) Show failed/errored profiles grouped by status, with messages
        grouped_by_status = failed_profiles |>
            @groupby({_.status}) |>
            @map({key(_).status, profiles=_}) |>
            @orderby(get(STATUS_SEVERITY, _.status, 99)) |>
            collect

        for grp in grouped_by_status
            grp_emoji = status_emoji(grp.status)
            grp_profiles = compress_profile_lists(map(p -> p.profile_name, grp.profiles))
            println(o, "> ### $(grp_emoji) $(titlecase(string(grp.status)))")
            println(o, "> **Profiles:** $(grp_profiles)")
            println(o, ">")

            deduplicated_messages = grp.profiles |>
                @filter(_.messages !== missing) |>
                @mapmany(_.messages, {_.profile_name, __.uri, __.line, __.message, __.stack_frames}) |>
                @groupby({uri=convert_to_uri(_.uri), _.line, message=agnostic_message(_.message)}) |>
                @map({key(_)..., profile_names=_.profile_name, stack_frames=let sfs = collect(Iterators.filter(sf -> sf !== missing, _.stack_frames)); isempty(sfs) ? missing : sfs[1] end}) |>
                collect

            if !isempty(deduplicated_messages)
                for msg in deduplicated_messages
                    github_uri = github_uri_from_uri(msg.uri, msg.line)
                    msg_profiles = compress_profile_lists(msg.profile_names)
                    println(o, "> **[$(msg.uri.path):$(msg.line)]($(github_uri))** on $(msg_profiles)")
                    println(o, ">")
                    println(o, "> ```")
                    println(o, "> $(replace(msg.message, "\n" => "\n> "))")
                    println(o, "> ```")
                    println(o, ">")
                    if msg.stack_frames !== missing && !isempty(msg.stack_frames)
                        println(o, "> **Stack trace:**")
                        for frame in msg.stack_frames
                            frame_github_uri = github_uri_from_uri(frame.uri, frame.line)
                            frame_path = convert_to_uri(frame.uri).path
                            println(o, "> - `$(frame.label)` at [$(frame_path):$(frame.line)]($(frame_github_uri))")
                        end
                        println(o, ">")
                    end
                end
            end
        end

        # 3) Raw output for all non-passed profiles, collapsed at the end
        profiles_with_output = filter(p -> p.output !== missing && !isempty(strip(p.output)), failed_profiles)
        if !isempty(profiles_with_output)
            for p in profiles_with_output
                println(o, "> <details>")
                println(o, "> <summary>Raw output — $(replace(p.profile_name, "~" => "\\~"))</summary>")
                println(o, ">")
                println(o, "> ```")
                println(o, "> $(replace(p.output, "\n" => "\n> "))")
                println(o, "> ```")
                println(o, ">")
                println(o, "> </details>")
                println(o, ">")
            end
        end
    end

    println(o, "</details>")
    println(o)
end

add_to_file("GITHUB_STEP_SUMMARY", String(take!(o)))

if fail_overall
    exit(1)
end
