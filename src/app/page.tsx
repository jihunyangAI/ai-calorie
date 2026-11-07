"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { getSupabaseClient, Meal } from "@/lib/supabase";

interface AnalyzedDraft {
  food_name: string;
  calories: number;
  thumbnailDataUrl: string;
  previewDataUrl: string;
}

function getLocalTodayString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDateString(dateStr: string, offsetDays: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + offsetDays);
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatKoreanDate(dateStr: string, todayStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const dayOfWeek = weekdays[dt.getDay()];
  const base = `${y}년 ${m}월 ${d}일 (${dayOfWeek})`;
  if (dateStr === todayStr) return `${base} · 오늘`;
  if (dateStr === shiftDateString(todayStr, -1)) return `${base} · 어제`;
  if (dateStr === shiftDateString(todayStr, 1)) return `${base} · 내일`;
  return base;
}

function formatTime(isoString?: string): string {
  if (!isoString) return "";
  try {
    const dt = new Date(isoString);
    return dt.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// 업로드용 이미지 리사이즈 (Gemini 전송용 + 카드 썸네일 생성)
async function processImageFile(file: File): Promise<{
  base64DataUrl: string;
  thumbnailDataUrl: string;
  mimeType: string;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const originalDataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => {
        // 1. Gemini 분석용 (최대 1024px)
        const maxAnalyzeDim = 1024;
        let aW = img.width;
        let aH = img.height;
        if (aW > maxAnalyzeDim || aH > maxAnalyzeDim) {
          if (aW > aH) {
            aH = Math.round((aH * maxAnalyzeDim) / aW);
            aW = maxAnalyzeDim;
          } else {
            aW = Math.round((aW * maxAnalyzeDim) / aH);
            aH = maxAnalyzeDim;
          }
        }
        const analyzeCanvas = document.createElement("canvas");
        analyzeCanvas.width = aW;
        analyzeCanvas.height = aH;
        const aCtx = analyzeCanvas.getContext("2d");
        aCtx?.drawImage(img, 0, 0, aW, aH);
        const base64DataUrl = analyzeCanvas.toDataURL("image/jpeg", 0.85);

        // 2. DB 카드 표시용 썸네일 (160px 정사각형 크롭)
        const thumbSize = 160;
        const thumbCanvas = document.createElement("canvas");
        thumbCanvas.width = thumbSize;
        thumbCanvas.height = thumbSize;
        const tCtx = thumbCanvas.getContext("2d");
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        tCtx?.drawImage(
          img,
          sx,
          sy,
          minSide,
          minSide,
          0,
          0,
          thumbSize,
          thumbSize
        );
        const thumbnailDataUrl = thumbCanvas.toDataURL("image/jpeg", 0.75);

        resolve({
          base64DataUrl,
          thumbnailDataUrl,
          mimeType: "image/jpeg",
        });
      };
      img.onerror = () => reject(new Error("이미지를 불러올 수 없습니다."));
      img.src = originalDataUrl;
    };
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.readAsDataURL(file);
  });
}

export default function CalorieTrackerPage() {
  const [todayStr, setTodayStr] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [meals, setMeals] = useState<Meal[]>([]);
  const [loadingMeals, setLoadingMeals] = useState<boolean>(true);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analyzedDraft, setAnalyzedDraft] = useState<AnalyzedDraft | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const today = getLocalTodayString();
    setTodayStr(today);
    setSelectedDate(today);
  }, []);

  // 선택된 날짜의 식사 목록 불러오기 (Supabase 클라이언트 사용)
  const fetchMeals = useCallback(async (dateToFetch: string) => {
    if (!dateToFetch) return;
    setLoadingMeals(true);
    try {
      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase 클라이언트가 설정되지 않았습니다.");
      }

      const { data, error } = await supabase
        .from("meals")
        .select("*")
        .eq("meal_date", dateToFetch)
        .order("created_at", { ascending: false });

      if (error) {
        throw error;
      }

      setMeals(Array.isArray(data) ? (data as Meal[]) : []);
    } catch (err) {
      console.error("식사 목록 조회 오류:", err);
    } finally {
      setLoadingMeals(false);
    }
  }, []);

  useEffect(() => {
    if (selectedDate) {
      fetchMeals(selectedDate);
    }
  }, [selectedDate, fetchMeals]);

  const totalCalories = meals.reduce(
    (sum, item) => sum + (Number(item.calories) || 0),
    0
  );

  const handlePrevDay = () => {
    setErrorMsg(null);
    setSelectedDate((prev) => shiftDateString(prev, -1));
  };

  const handleNextDay = () => {
    setErrorMsg(null);
    setSelectedDate((prev) => shiftDateString(prev, 1));
  };

  const handleGoToday = () => {
    if (!todayStr) return;
    setErrorMsg(null);
    setSelectedDate(todayStr);
  };

  // 1단계: 음식 사진 업로드 시 Gemini API로 음식명과 칼로리 분석
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setAnalyzedDraft(null);
    setAnalyzing(true);

    try {
      const { base64DataUrl, thumbnailDataUrl, mimeType } =
        await processImageFile(file);
      setPreviewUrl(base64DataUrl);

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: base64DataUrl,
          mimeType,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "음식 사진 분석에 실패했습니다.");
      }

      setAnalyzedDraft({
        food_name: data.food_name,
        calories: Number(data.calories),
        thumbnailDataUrl,
        previewDataUrl: base64DataUrl,
      });
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "음식 분석 중 오류가 발생했습니다."
      );
      setPreviewUrl(null);
    } finally {
      setAnalyzing(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  // 2단계: "저장하기" 버튼 클릭 시 작동 흐름
  // 1. 수파베이스 클라이언트를 사용한다.
  // 2. meals 테이블에 현재 선택된 날짜(YYYY-MM-DD), 분석된 음식이름(food_name), 분석된 칼로리(calories)를 추가한다. (기존 테이블 컬럼명 meal_date에 맞춤)
  // 3. 저장 성공 시 식사목록을 즉시 다시 불러온다.
  // 4. 저장 실패 시 화면에 '저장에 실패했습니다. 다시 시도해주세요' 메시지를 표시한다.
  const handleSaveMeal = async () => {
    if (!analyzedDraft || !selectedDate) return;

    setSaving(true);
    setErrorMsg(null);

    try {
      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      const { error } = await supabase.from("meals").insert([
        {
          meal_date: selectedDate, // 현재 선택된 날짜 (YYYY-MM-DD 형식, 테이블 컬럼명 meal_date)
          food_name: analyzedDraft.food_name,
          calories: analyzedDraft.calories,
          image_url: analyzedDraft.thumbnailDataUrl,
        },
      ]);

      if (error) {
        throw error;
      }

      // 저장 성공 시 분석 카드 초기화 및 식사 목록 즉시 다시 불러오기
      setAnalyzedDraft(null);
      setPreviewUrl(null);
      await fetchMeals(selectedDate);
    } catch (err) {
      console.error("Supabase 저장 실패:", err);
      setErrorMsg("저장에 실패했습니다. 다시 시도해주세요");
    } finally {
      setSaving(false);
    }
  };

  // 개별 식사 기록 삭제 (X 버튼)
  const handleDeleteMeal = async (id: string) => {
    setDeletingId(id);
    setErrorMsg(null);
    try {
      const supabase = getSupabaseClient();
      if (!supabase) {
        throw new Error("Supabase client not initialized");
      }

      const { error } = await supabase.from("meals").delete().eq("id", id);
      if (error) {
        throw error;
      }

      await fetchMeals(selectedDate);
    } catch (err) {
      console.error("삭제 오류:", err);
      setErrorMsg("삭제에 실패했습니다. 다시 시도해주세요");
    } finally {
      setDeletingId(null);
    }
  };

  if (!selectedDate) {
    return <div className="min-h-screen bg-white" />;
  }

  return (
    <main className="min-h-screen bg-white text-gray-900 py-8 px-4">
      <div className="max-w-lg mx-auto space-y-6">
        {/* 앱 타이틀 */}
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            AI 음식 칼로리 기록
          </h1>
          <p className="text-sm text-gray-500">
            음식 사진을 올리면 Gemini AI가 음식명과 칼로리를 자동 분석합니다
          </p>
        </div>

        {/* 상단: 날짜 이동 및 총 칼로리 카드 */}
        <section className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm space-y-5">
          {/* 날짜 이동 버튼 (◀ 어제 / 날짜 / 내일 ▶) */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={handlePrevDay}
              className="px-3.5 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 active:bg-gray-200 border border-gray-200 rounded-xl transition cursor-pointer shrink-0"
            >
              ◀ 어제
            </button>

            <div className="text-center">
              <div className="text-base sm:text-lg font-semibold text-gray-900">
                {formatKoreanDate(selectedDate, todayStr)}
              </div>
              {selectedDate !== todayStr && (
                <button
                  type="button"
                  onClick={handleGoToday}
                  className="mt-1 text-xs font-medium text-emerald-600 hover:text-emerald-700 underline cursor-pointer"
                >
                  오늘 날짜로 돌아가기
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={handleNextDay}
              className="px-3.5 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 active:bg-gray-200 border border-gray-200 rounded-xl transition cursor-pointer shrink-0"
            >
              내일 ▶
            </button>
          </div>

          <div className="border-t border-gray-100 pt-4 text-center">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
              총 섭취 칼로리
            </p>
            <div className="mt-1 flex items-baseline justify-center gap-1.5">
              <span
                data-testid="total-calories"
                className="text-4xl font-extrabold tracking-tight text-emerald-600"
              >
                {totalCalories.toLocaleString()}
              </span>
              <span className="text-lg font-semibold text-gray-600">kcal</span>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              기록된 식사 {meals.length}건
            </p>
          </div>
        </section>

        {/* 음식 사진 업로드 및 분석 결과 확인 / 저장하기 영역 */}
        <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            disabled={analyzing || saving}
            className="hidden"
            id="food-photo-input"
          />

          <label
            htmlFor="food-photo-input"
            className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-6 text-center transition cursor-pointer ${
              analyzing
                ? "border-emerald-300 bg-emerald-50/40 cursor-wait"
                : "border-gray-300 hover:border-emerald-500 hover:bg-gray-50/60"
            }`}
          >
            {analyzing ? (
              <div className="space-y-3 py-2">
                {previewUrl && (
                  <img
                    src={previewUrl}
                    alt="분석 중인 음식"
                    className="w-24 h-24 object-cover rounded-xl mx-auto border border-gray-200 shadow-sm"
                  />
                )}
                <div className="flex items-center justify-center gap-2 text-emerald-700 font-semibold text-sm">
                  <span className="w-4 h-4 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin inline-block" />
                  Gemini AI가 음식명과 칼로리를 분석하고 있습니다...
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto text-2xl">
                  📷
                </div>
                <div className="text-sm font-semibold text-gray-800">
                  음식 사진 업로드하기
                </div>
                <p className="text-xs text-gray-500">
                  클릭하여 사진을 선택하면 AI가 음식명과 칼로리를 분석합니다
                </p>
              </div>
            )}
          </label>

          {/* 분석 완료 후 "저장하기" 카드 */}
          {analyzedDraft && !analyzing && (
            <div className="p-4 bg-emerald-50/60 border border-emerald-200 rounded-xl space-y-4">
              <div className="flex items-center gap-3.5">
                <img
                  src={analyzedDraft.thumbnailDataUrl}
                  alt={analyzedDraft.food_name}
                  className="w-16 h-16 rounded-xl object-cover border border-emerald-200 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <span className="inline-block text-[11px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md">
                    AI 분석 결과 ({selectedDate})
                  </span>
                  <h3 className="text-base font-bold text-gray-900 mt-1 truncate">
                    {analyzedDraft.food_name}
                  </h3>
                  <p className="text-sm font-semibold text-emerald-700">
                    {analyzedDraft.calories.toLocaleString()} kcal
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveMeal}
                  disabled={saving}
                  className="flex-1 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-semibold rounded-xl shadow-sm transition cursor-pointer disabled:opacity-50"
                >
                  {saving ? "저장 중..." : "저장하기"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnalyzedDraft(null);
                    setPreviewUrl(null);
                    setErrorMsg(null);
                  }}
                  disabled={saving}
                  className="py-2.5 px-4 bg-white hover:bg-gray-100 text-gray-600 border border-gray-200 text-sm font-medium rounded-xl transition cursor-pointer disabled:opacity-50"
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {/* 에러 메시지 ('저장에 실패했습니다. 다시 시도해주세요' 등) */}
          {errorMsg && (
            <div
              role="alert"
              className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm font-medium text-red-700 text-center"
            >
              {errorMsg}
            </div>
          )}
        </section>

        {/* 식사 기록 카드형 목록 */}
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-base font-bold text-gray-900">식사 목록</h2>
            <span className="text-xs text-gray-500">{selectedDate} 기준</span>
          </div>

          {loadingMeals ? (
            <div className="space-y-3">
              {[1, 2].map((n) => (
                <div
                  key={n}
                  className="bg-white border border-gray-200 rounded-2xl p-4 h-20 animate-pulse flex items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gray-100" />
                    <div className="space-y-2">
                      <div className="w-28 h-4 bg-gray-100 rounded" />
                      <div className="w-16 h-3 bg-gray-100 rounded" />
                    </div>
                  </div>
                  <div className="w-16 h-5 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          ) : meals.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center space-y-2 shadow-sm">
              <div className="text-3xl">🍽️</div>
              <p className="text-sm font-medium text-gray-700">
                이 날짜에 기록된 식사가 없습니다.
              </p>
              <p className="text-xs text-gray-400">
                위에서 음식 사진을 업로드해 칼로리를 분석하고 저장해 보세요!
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {meals.map((meal) => (
                <article
                  key={meal.id}
                  data-testid="meal-card"
                  className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm hover:border-gray-300 transition flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    {meal.image_url ? (
                      <img
                        src={meal.image_url}
                        alt={meal.food_name}
                        className="w-14 h-14 rounded-xl object-cover border border-gray-100 shrink-0"
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-center text-xl shrink-0">
                        🥗
                      </div>
                    )}

                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-gray-900 truncate">
                        {meal.food_name}
                      </h3>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatTime(meal.created_at)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <span className="text-base font-bold text-gray-900">
                        {Number(meal.calories).toLocaleString()}
                      </span>
                      <span className="text-xs text-gray-500 ml-1">kcal</span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteMeal(meal.id)}
                      disabled={deletingId === meal.id}
                      aria-label={`${meal.food_name} 삭제`}
                      title="삭제"
                      className="w-8 h-8 rounded-lg border border-gray-200 text-gray-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 flex items-center justify-center text-sm font-bold transition cursor-pointer disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
