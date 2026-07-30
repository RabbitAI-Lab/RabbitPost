import { ok } from "../../../lib/http";

export async function GET() {
  return ok({ status: "up", service: "rabbitpost-api", time: new Date().toISOString() });
}
