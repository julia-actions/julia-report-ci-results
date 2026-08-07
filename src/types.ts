// Schema of the test-result JSON files, as written by
// TestItemControllers.Results.write_json (TestItemControllers/src/results.jl).
// Optional fields are serialized as null (never omitted).

export type TestStatus = 'passed' | 'failed' | 'errored' | 'skipped' | 'timeout' | 'crash';

export interface StackFrame {
    label: string;
    uri: string;
    line: number;
    column: number;
}

export interface TestMessage {
    message: string;
    expected_output: string | null;
    actual_output: string | null;
    uri: string;
    line: number;
    column: number;
    stack_frames: StackFrame[] | null;
}

export interface TestitemProfile {
    profile_name: string;
    status: TestStatus | string; // unknown statuses are kept and rendered as ❓
    duration: number | null; // milliseconds
    messages: TestMessage[] | null;
    output: string | null;
}

export interface Testitem {
    name: string;
    uri: string;
    profiles: TestitemProfile[];
}

export interface DefinitionError {
    message: string;
    uri: string;
    line: number;
    column: number;
}

export interface TestrunResult {
    definition_errors: DefinitionError[];
    testitems: Testitem[];
    process_outputs: Record<string, string>;
}

// Flattened lint diagnostic derived from julialint's SARIF output.

export type LintLevel = 'error' | 'warning' | 'note';

export interface LintDiagnostic {
    level: LintLevel;
    relPath: string | null; // repo-relative with forward slashes, as emitted by julialint
    line: number | null;
    ruleId: string;
    message: string;
    toolName: string;
}
