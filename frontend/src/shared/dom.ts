export function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing interface element: ${selector}`);
  return result;
}

export class RequestError extends Error {
  constructor(message: string, public status?: number, options?: ErrorOptions) {
    super(message, options);
  }
}

export function asError(value: unknown): RequestError {
  return value instanceof Error ? value : new RequestError(String(value));
}
