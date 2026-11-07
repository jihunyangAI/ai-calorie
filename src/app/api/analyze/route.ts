import { NextRequest, NextResponse } from "next/server";

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.5-pro",
  "gemini-flash-lite-latest",
];

export async function POST(req: NextRequest) {
  try {
    const { imageBase64, mimeType } = (await req.json()) as {
      imageBase64?: string;
      mimeType?: string;
    };

    if (!imageBase64) {
      return NextResponse.json(
        { error: "음식 사진 데이터가 필요합니다." },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다." },
        { status: 500 }
      );
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/[\w+.-]+;base64,/, "");
    const resolvedMimeType =
      mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg";

    const prompt = `당신은 전문 영양사이자 음식 칼로리 분석 AI입니다.
업로드된 사진을 보고 어떤 음식인지 한국어로 명확하게 판별하고, 사진 속 분량(1인분 기준 또는 사진에 보이는 양)의 총 예상 칼로리(kcal)를 정수로 추정해 주세요.
음식이 여러 개라면 대표적인 식사명(예: "돈까스 정식", "김치볶음밥과 계란후라이", "닭가슴살 샐러드")으로 묶고 전체 합산 칼로리를 계산하세요.

반드시 아래 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 순수 JSON만 출력):
{"food_name": "한국어 음식명", "calories": 550}`;

    const requestBody = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: resolvedMimeType,
                data: cleanBase64,
              },
            },
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    });

    let lastError = "";

    for (const model of GEMINI_MODELS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            signal: controller.signal,
          }
        );
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errText = await res.text();
          lastError = `${model}: ${res.status} ${errText}`;
          continue;
        }

        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts;
        const text = Array.isArray(parts)
          ? parts
              .filter(
                (p: { text?: string; thought?: boolean }) =>
                  !p.thought && typeof p.text === "string"
              )
              .map((p: { text: string }) => p.text)
              .join("")
              .trim()
          : "";

        if (!text) continue;

        const cleanedJson = text
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```$/i, "")
          .trim();

        const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleanedJson);

        const foodName =
          typeof parsed.food_name === "string" && parsed.food_name.trim()
            ? parsed.food_name.trim()
            : "분석된 음식";
        const caloriesNum = Math.max(
          1,
          Math.round(Number(parsed.calories) || 350)
        );

        return NextResponse.json({
          food_name: foodName,
          calories: caloriesNum,
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return NextResponse.json(
      { error: `Gemini 이미지 분석에 실패했습니다. (${lastError})` },
      { status: 500 }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "분석 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
