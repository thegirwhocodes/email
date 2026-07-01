import { NextResponse } from "next/server";
import { getReadinessReport } from "@/lib/config/readiness";

export const runtime = "nodejs";

export async function GET() {
  const report = await getReadinessReport();
  return NextResponse.json(report, {
    status: report.status === "fail" ? 503 : 200,
  });
}
