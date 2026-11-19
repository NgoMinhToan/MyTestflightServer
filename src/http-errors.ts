import type { FastifyReply } from "fastify";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): void {
  reply.code(statusCode).send({ error: { code, message } });
}
