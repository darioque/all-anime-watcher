/**
 * An outcome the caller is expected to handle, not a defect.
 *
 * The player walks a list of servers until one plays, so "no extractor for this
 * host" and "this server is dead" are routine. Logging those with a stack trace
 * buries the one error that actually matters in noise, so the router reports
 * them quietly.
 */
export class ExpectedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ExpectedError"
    }
}

export function isExpected(error: unknown): boolean {
    return error instanceof Error && error.name === "ExpectedError"
}
