import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, Meal } from "@/lib/supabase";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

const FALLBACK_FILE = path.join(process.cwd(), "data", "meals-fallback.json");

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.5-pro",
  "gemini-flash-lite-latest",
];

async function readFallbackMeals(): Promise<Meal[]> {
  try {
    const raw = await fs.readFile(FALLBACK_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeFallbackMeals(meals: Meal[]): Promise<void> {
  const dir = path.dirname(FALLBACK_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(FALLBACK_FILE, JSON.stringify(meals, null, 2), "utf-8");
}

function isTableMissingError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    Boolean(error.message?.includes("Could not find the table"))
  );
}

interface AnalyzedFoodResult {
  food_name: string;
  calories: number;
}

async function analyzeFoodImageWithGemini(
  imageBase64: string,
  mimeType: string
): Promise<AnalyzedFoodResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  const cleanBase64 = imageBase64.replace(/^data:image\/[\w+.-]+;base64,/, "");
  const resolvedMimeType = mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg";

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

      return {
        food_name: foodName,
        calories: caloriesNum,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(`Gemini 이미지 분석에 실패했습니다. (${lastError})`);
}

// GET /api/meals?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date =
    searchParams.get("date") || new Date().toISOString().slice(0, 10);

  const supabase = getSupabaseClient();

  if (supabase) {
    const { data, error } = await supabase
      .from("meals")
      .select("*")
      .eq("meal_date", date)
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data)) {
      // 만약 이전에 로컬 폴백에 저장된 데이터가 있다면 자동으로 Supabase로 동기화
      const fallbackMeals = await readFallbackMeals();
      if (fallbackMeals.length > 0) {
        const toInsert = fallbackMeals.map((m) => ({
          id: m.id,
          food_name: m.food_name,
          calories: m.calories,
          meal_date: m.meal_date,
          image_url: m.image_url ?? null,
          created_at: m.created_at,
        }));
        const { error: syncErr } = await supabase
          .from("meals")
          .upsert(toInsert, { onConflict: "id" });
        if (!syncErr) {
          await writeFallbackMeals([]);
          const { data: refreshed } = await supabase
            .from("meals")
            .select("*")
            .eq("meal_date", date)
            .order("created_at", { ascending: false });
          return NextResponse.json({
            meals: refreshed ?? data,
            storage: "supabase",
            tableMissing: false,
          });
        }
      }

      return NextResponse.json({
        meals: data,
        storage: "supabase",
        tableMissing: false,
      });
    }

    if (isTableMissingError(error)) {
      const allFallback = await readFallbackMeals();
      const filtered = allFallback
        .filter((m) => m.meal_date === date)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return NextResponse.json({
        meals: filtered,
        storage: "fallback",
        tableMissing: true,
      });
    }

    return NextResponse.json(
      { error: error?.message || "식사 목록을 불러오지 못했습니다." },
      { status: 500 }
    );
  }

  const allFallback = await readFallbackMeals();
  const filtered = allFallback
    .filter((m) => m.meal_date === date)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return NextResponse.json({
    meals: filtered,
    storage: "fallback",
    tableMissing: true,
  });
}

// POST /api/meals - 음식 사진 Gemini 분석 후 Supabase meals 테이블에 저장
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      imageBase64,
      mimeType,
      mealDate,
      thumbnailDataUrl,
      food_name: manualFoodName,
      calories: manualCalories,
    } = body as {
      imageBase64?: string;
      mimeType?: string;
      mealDate?: string;
      thumbnailDataUrl?: string;
      food_name?: string;
      calories?: number;
    };

    const targetDate = mealDate || new Date().toISOString().slice(0, 10);

    let foodName = manualFoodName?.trim() || "";
    let calories = Number(manualCalories) || 0;

    if (imageBase64) {
      const analyzed = await analyzeFoodImageWithGemini(
        imageBase64,
        mimeType || "image/jpeg"
      );
      foodName = analyzed.food_name;
      calories = analyzed.calories;
    }

    if (!foodName || calories <= 0) {
      return NextResponse.json(
        { error: "유효한 음식 사진 또는 음식 정보가 필요합니다." },
        { status: 400 }
      );
    }

    const newMeal: Meal = {
      id: crypto.randomUUID(),
      food_name: foodName,
      calories,
      meal_date: targetDate,
      image_url: thumbnailDataUrl || null,
      created_at: new Date().toISOString(),
    };

    const supabase = getSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase
        .from("meals")
        .insert([
          {
            id: newMeal.id,
            food_name: newMeal.food_name,
            calories: newMeal.calories,
            meal_date: newMeal.meal_date,
            image_url: newMeal.image_url,
            created_at: newMeal.created_at,
          },
        ])
        .select()
        .single();

      if (!error && data) {
        return NextResponse.json({
          meal: data,
          storage: "supabase",
          tableMissing: false,
        });
      }

      if (isTableMissingError(error)) {
        const current = await readFallbackMeals();
        current.unshift(newMeal);
        await writeFallbackMeals(current);
        return NextResponse.json({
          meal: newMeal,
          storage: "fallback",
          tableMissing: true,
        });
      }

      return NextResponse.json(
        { error: error?.message || "Supabase 저장 중 오류가 발생했습니다." },
        { status: 500 }
      );
    }

    const current = await readFallbackMeals();
    current.unshift(newMeal);
    await writeFallbackMeals(current);

    return NextResponse.json({
      meal: newMeal,
      storage: "fallback",
      tableMissing: true,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "요청 처리 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/meals?id=UUID - 개별 식사 기록 삭제
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { error: "삭제할 항목의 id가 필요합니다." },
        { status: 400 }
      );
    }

    const supabase = getSupabaseClient();
    if (supabase) {
      const { error } = await supabase.from("meals").delete().eq("id", id);
      if (error && !isTableMissingError(error)) {
        return NextResponse.json(
          { error: error.message || "삭제 중 오류가 발생했습니다." },
          { status: 500 }
        );
      }
    }

    const current = await readFallbackMeals();
    const nextMeals = current.filter((m) => m.id !== id);
    if (nextMeals.length !== current.length) {
      await writeFallbackMeals(nextMeals);
    }

    return NextResponse.json({ deletedId: id, ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "삭제 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
