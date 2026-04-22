export class NoReadyWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoReadyWorkError";
  }
}

export function isNoReadyWorkError(error: unknown): error is NoReadyWorkError {
  return error instanceof NoReadyWorkError
    || (error instanceof Error && error.name === "NoReadyWorkError");
}
