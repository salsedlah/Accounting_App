import { z } from "zod";
import { ensureReady } from "@/db/bootstrap";
import { transaction } from "@/db/client";
import { PERMISSIONS } from "@/lib/constants";
import { ok, readJson, route } from "@/server/api";
import { requirePermission } from "@/server/auth";
import { answerQuestion } from "@/server/ai";

const schema = z.object({ question: z.string().min(2).max(500) });

export async function POST(request: Request) {
  return route(async () => {
    await ensureReady();
    const session = await requirePermission(PERMISSIONS.aiAsk);
    const { question } = schema.parse(await readJson(request));
    const answer = await transaction((tx) =>
      answerQuestion(tx, session, question, session.businessId),
    );
    return ok(answer);
  });
}
