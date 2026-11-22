// Text of the document-feature sample (scripts/doc-sample/build.ts).
//
// ORIG: the Korean feature sample (qa/samples/doc-features, ?store absent) — unchanged wording.
// STORE[lang]: the Store-screenshot variant in each UI language (?store=1&lang=ko|en|ja|zh → qa/samples/store-sample/<lang>/).
// A made-up company ("견본 상사" / Sample Trading Co.) and made-up numbers; no product names, real people or internal names.
// Every mark needle must occur in its paragraph (build.ts throws "mark not found" otherwise).

export type MarkKind = "num" | "italic" | "strike" | "bold" | "sub" | "sup" | "hl" | "ul";
export type TMark = [needle: string, kind: MarkKind, from?: number, to?: number];
export interface Item {
  text: string;
  level?: 0 | 1 | 2;
  bold?: string;
}
export interface DocText {
  font: string;
  /** body paragraphs: JUSTIFY unless set (Japanese reads better ragged: justified lines open gaps at format changes) */
  bodyAlign?: "LEFT" | "JUSTIFY";
  docTitle: string;
  header: string;
  title: string;
  sub: string;
  meta: string;
  hSummary: string;
  body1: string;
  body1Marks: TMark[];
  tag: string;
  tagA: string;
  tagB: string;
  hHighlights: string;
  bullets: Item[];
  hNext: string;
  numPreset: string;
  nums: Item[];
  hNote: string;
  note: string;
  noteBold: string;
  hResults: string;
  hMonthly: string;
  pTable: string;
  t1Head: string[];
  /** [group label, row label, oct, nov, dec] ×4 (group label on rows 0 and 2) */
  t1Rows: string[][];
  t1Total: string;
  t1Caption: string;
  t1CaptionBold: string;
  figCaption: string;
  figCaptionBold: string;
  hComment: string;
  hChannel: string;
  pComment: string;
  pCommentBold: string;
  pNext: string;
  pNextBold: string;
  hAppA: string;
  pAppA: string;
  pAppABold: string;
  t2Head: string[];
  t2Rows: string[];
  t2Caption: string;
  t2CaptionBold: string;
  sample: string;
  hAppB: string;
  lExact: string;
  lPct: string;
  lMult: string;
  lSpace: string;
  lScale: string;
  lSpacing: string;
  lNormal: string;
}

const NAME = "Office Surgeon";
const ORIG_LEAD = "2026년 4분기 Omni 사용자는 전 분기보다 18.4% 늘었고";

export const ORIG: DocText = {
  font: "Pretendard",
  docTitle: "Omni 분기 보고서 — 2026년 4분기 (오메 견본)",
  header: "Omni 분기 보고서 · 2026년 4분기",
  title: "Omni 분기 보고서",
  sub: "2026년 4분기 · Quarterly Report Q4 2026",
  meta: "작성: 오메 문서부  |  작성일: 2026년 11월 12일  |  문서 번호: OMW-Q4-SAMPLE",
  hSummary: "요약 (Executive Summary)",
  body1: `${ORIG_LEAD}, 저장 형식 가운데 HWPX 비중이 처음으로 DOCX를 앞질렀습니다. 이 수치는 잠정치가 아닌 확정치이며, 탄소 지표는 CO2 환산량, 사무실 면적은 m2 단위로 적었습니다. 편집 세션의 중앙값은 23분으로, ${NAME} 도입 뒤 원본 보존 저장을 쓰는 사람이 꾸준히 늘었습니다.`,
  body1Marks: [["18.4%", "num"], ["HWPX", "italic"], ["잠정치", "strike"], ["확정치", "bold"], ["CO2", "sub", 2, 3], ["m2", "sup", 1, 2], ["편집 세션의 중앙값은 23분", "hl"], [NAME, "ul"]],
  tag: "한 캔버스, 모든 형식 — One canvas, every format.",
  tagA: "한 캔버스, 모든 형식",
  tagB: "One canvas, every format.",
  hHighlights: "주요 성과",
  bullets: [
    { text: "문서 편집: 글자·문단 단위 서식, 제목 스타일, 글머리표·번호 목록", bold: "문서 편집" },
    { text: "글자 서식 — 취소선·위/아래 첨자·형광펜·자간·장평", level: 1 },
    { text: "문단 서식 — 정렬·들여쓰기·오른쪽 여백·줄 간격(배수·고정·최소)·문단 앞뒤 간격", level: 1 },
    { text: `원본 보존 저장(${NAME} 1단계): DOCX·XLSX·HWPX에서 바뀐 문단만 다시 씀`, bold: "원본 보존 저장" },
  ],
  hNext: "다음 분기 과제",
  numPreset: "korean",
  nums: [
    { text: "각주·미주와 다단", bold: "각주·미주" },
    { text: "문서 모델에 각주 영역", level: 1 },
    { text: "DOCX footnotes·HWPX hp:footNote로 저장", level: 2 },
    { text: "각주 번호 필드", level: 2 },
    { text: "구역마다 단 수·단 간격", level: 1 },
    { text: "그림·도형을 DOCX·HWPX로 저장, 머리말 속 그림" },
    { text: "편집 중 자동 쪽 넘김(본문 흐름)" },
  ],
  hNote: "참고",
  note: "내어쓰기: 첫 줄은 왼쪽으로 내밀고 둘째 줄부터는 들여 써서 항목 이름이 눈에 띄게 하는 문단 모양입니다. Hanging indents keep the label flush while the text wraps neatly.",
  noteBold: "내어쓰기:",
  hResults: "실적",
  hMonthly: "분기별 지표",
  pTable: "아래 표는 월별 지표를 정리한 것입니다. 첫 열은 세로로 합친 셀, 마지막 행의 이름 칸은 가로로 합친 셀이고, 머리글 행은 배경색으로 구분했습니다.",
  t1Head: ["분류", "지표", "10월", "11월", "12월"],
  t1Rows: [
    ["사용", "활성 사용자(명)", "12,480", "13,920", "14,770"],
    ["", "새 문서(건)", "41,205", "44,890", "47,312"],
    ["형식", "HWPX 저장 비율", "38.2%", "41.5%", "44.9%"],
    ["", "DOCX 저장 비율", "43.0%", "41.1%", "39.6%"],
  ],
  t1Total: "분기 합계 (새 문서)",
  t1Caption: "표 1. 2026년 4분기 주요 지표 (예시 수치)",
  t1CaptionBold: "표 1.",
  figCaption: "그림 1. 그림 개체(앱 아이콘)와 벡터 도형(실 가닥) — Image & vector objects",
  figCaptionBold: "그림 1.",
  hComment: "해설",
  hChannel: "형식별 흐름",
  pComment:
    "11월부터 공공기관 서식을 HWPX로 그대로 고쳐 저장하는 사례가 늘면서 HWPX 비율이 꾸준히 올랐습니다. Word users, meanwhile, mostly exported to PDF for sharing, which kept the DOCX share slightly lower in December. 표의 합계 행은 같은 분기 안의 새 문서 수를 더한 값입니다.",
  pCommentBold: "Word users",
  pNext: "다음 쪽은 용지 방향을 가로로 바꾼 부록입니다.",
  pNextBold: "가로",
  hAppA: "부록 A. 형식별 열기·저장 건수",
  pAppA: "이 쪽부터 새 구역입니다. 구역마다 용지 크기·방향·여백을 따로 정합니다(쪽 설정). 이 구역은 A4 가로, 여백 15 mm입니다. (A new section: A4 landscape with its own margins.)",
  pAppABold: "새 구역",
  t2Head: ["형식", "열기 10월", "열기 11월", "열기 12월", "저장 10월", "저장 11월", "저장 12월", "분기 증감"],
  t2Rows: ["HWPX", "DOCX", "PDF", "PPTX"],
  t2Caption: "표 2. 형식별 열기·저장 건수 (예시 수치)",
  t2CaptionBold: "표 2.",
  sample: "Omni 분기 보고서는 이번 분기의 매출과 비용, 다음 분기의 계획을 한 문서에 정리합니다. The same sentence keeps going so the lines wrap, and the line spacing of each paragraph shows between its lines.",
  hAppB: "부록 B. 문단·글자 모양",
  lExact: "[줄 간격 고정 18 pt]",
  lPct: "[줄 간격 글자 크기 200%(한글 방식)]",
  lMult: "[줄 간격 배수 2.0(Word 방식)]",
  lSpace: "[문단 위 14 pt · 아래 14 pt · 왼쪽·오른쪽 여백 60 pt]",
  lScale: "[장평 90%]",
  lSpacing: "[자간 −5%]",
  lNormal: "[보통]",
};

export const STORE: Record<"ko" | "en" | "ja" | "zh", DocText> = {
  ko: {
    font: "Pretendard",
    docTitle: "분기 보고서 — 2026년 4분기 (견본 상사)",
    header: "분기 보고서 · 2026년 4분기",
    title: "분기 보고서",
    sub: "2026년 4분기 · 견본 상사",
    meta: "작성: 기획팀  |  작성일: 2026년 11월 12일  |  문서 번호: SAMPLE-Q4",
    hSummary: "요약",
    body1:
      "4분기 매출은 전 분기보다 18.4% 늘었고, 온라인 주문 비중이 처음으로 매장 주문을 앞질렀습니다. 이 수치는 잠정치가 아닌 확정치입니다. 탄소 배출은 CO2 환산량, 창고 면적은 m2 단위로 적었습니다. 고객 응답 시간의 중앙값은 23분으로 줄었고, 새 주문 시스템을 쓰는 매장이 꾸준히 늘었습니다.",
    body1Marks: [["18.4%", "num"], ["온라인 주문", "italic"], ["잠정치", "strike"], ["확정치", "bold"], ["CO2", "sub", 2, 3], ["m2", "sup", 1, 2], ["고객 응답 시간의 중앙값은 23분", "hl"], ["새 주문 시스템", "ul"]],
    tag: "고객 가까이, 한발 먼저 — Closer to customers.",
    tagA: "고객 가까이, 한발 먼저",
    tagB: "Closer to customers.",
    hHighlights: "주요 성과",
    bullets: [
      { text: "온라인 판매: 주문 앱 개편, 당일 배송 지역 확대", bold: "온라인 판매" },
      { text: "주문 앱 — 장바구니와 결제 단계 축소", level: 1 },
      { text: "배송 — 수도권 당일 배송, 그 밖의 지역 익일 배송", level: 1 },
      { text: "매장 운영: 새 주문 시스템을 40개 매장에 도입", bold: "매장 운영" },
    ],
    hNext: "다음 분기 과제",
    numPreset: "korean",
    nums: [
      { text: "물류 센터 자동화", bold: "물류 센터 자동화" },
      { text: "입고 검수 자동화", level: 1 },
      { text: "바코드 스캐너 교체", level: 2 },
      { text: "검수 기록 전산화", level: 2 },
      { text: "출고 동선 정리", level: 1 },
      { text: "고객 문의 창구 통합" },
      { text: "친환경 포장재로 전환" },
    ],
    hNote: "참고",
    note: "내어쓰기: 첫 줄은 왼쪽으로 내밀고 둘째 줄부터 들여 써서 항목 이름이 눈에 띄게 하는 문단 모양입니다.",
    noteBold: "내어쓰기:",
    hResults: "실적",
    hMonthly: "월별 지표",
    pTable: "아래 표는 월별 지표입니다. 첫 열은 세로로 합친 셀, 마지막 행의 이름 칸은 가로로 합친 셀입니다.",
    t1Head: ["분류", "지표", "10월", "11월", "12월"],
    t1Rows: [
      ["주문", "온라인 주문(건)", "41,205", "44,890", "47,312"],
      ["", "매장 주문(건)", "38,640", "37,910", "36,450"],
      ["고객", "신규 고객(명)", "12,480", "13,920", "14,770"],
      ["", "재구매율", "38.2%", "41.5%", "44.9%"],
    ],
    t1Total: "분기 합계 (온라인 주문)",
    t1Caption: "표 1. 2026년 4분기 월별 지표 (예시 수치)",
    t1CaptionBold: "표 1.",
    figCaption: "그림 1. 그림 개체와 벡터 도형",
    figCaptionBold: "그림 1.",
    hComment: "해설",
    hChannel: "채널별 흐름",
    pComment: "11월부터 온라인 주문이 매장 주문을 앞서기 시작했습니다. 매장 주문은 줄었지만 재구매율은 꾸준히 올랐습니다. 표의 합계 행은 같은 분기의 온라인 주문 수를 더한 값입니다.",
    pCommentBold: "온라인 주문",
    pNext: "다음 쪽은 용지를 가로로 놓은 부록입니다.",
    pNextBold: "가로",
    hAppA: "부록 A. 채널별 주문 건수",
    pAppA: "이 쪽부터 새 구역입니다. 구역마다 용지 크기, 방향, 여백을 따로 정할 수 있고, 이 구역은 A4 가로에 여백 15 mm입니다.",
    pAppABold: "새 구역",
    t2Head: ["채널", "주문 10월", "주문 11월", "주문 12월", "반품 10월", "반품 11월", "반품 12월", "분기 증감"],
    t2Rows: ["온라인", "매장", "전화", "제휴처"],
    t2Caption: "표 2. 채널별 주문·반품 건수 (예시 수치)",
    t2CaptionBold: "표 2.",
    sample: "견본 상사는 이번 분기의 매출과 비용, 다음 분기 계획을 한 문서에 정리합니다. 문장이 길게 이어져 줄이 바뀌므로 문단마다 다른 줄 간격이 잘 보입니다.",
    hAppB: "부록 B. 문단과 글자 모양",
    lExact: "[줄 간격 고정 18 pt]",
    lPct: "[줄 간격 글자 크기의 200%]",
    lMult: "[줄 간격 배수 2.0]",
    lSpace: "[문단 위아래 14 pt, 좌우 여백 60 pt]",
    lScale: "[장평 90%]",
    lSpacing: "[자간 −5%]",
    lNormal: "[보통]",
  },
  en: {
    font: "Pretendard",
    docTitle: "Quarterly Report — Q4 2026 (Sample Trading Co.)",
    header: "Quarterly Report · Q4 2026",
    title: "Quarterly Report",
    sub: "Q4 2026 · Sample Trading Co.",
    meta: "Prepared by Planning  |  November 12, 2026  |  Doc no. SAMPLE-Q4",
    hSummary: "Summary",
    body1:
      "Q4 revenue grew 18.4% over the previous quarter, and online orders overtook in-store orders for the first time. These are final figures, not preliminary ones. Carbon emissions are given in CO2 equivalent and warehouse space in m2. The median customer response time fell to 23 minutes, and more stores moved to the new ordering system.",
    body1Marks: [["18.4%", "num"], ["online orders", "italic"], ["preliminary", "strike"], ["final figures", "bold"], ["CO2", "sub", 2, 3], ["m2", "sup", 1, 2], ["median customer response time fell to 23 minutes", "hl"], ["new ordering system", "ul"]],
    tag: "Closer to customers — one step ahead.",
    tagA: "Closer to customers",
    tagB: "one step ahead.",
    hHighlights: "Highlights",
    bullets: [
      { text: "Online sales: a redesigned ordering app and a wider same-day delivery area", bold: "Online sales" },
      { text: "Ordering app — fewer steps from cart to checkout", level: 1 },
      { text: "Delivery — same day in the capital area, next day elsewhere", level: 1 },
      { text: "Store operations: the new ordering system now runs in 40 stores", bold: "Store operations" },
    ],
    hNext: "Next quarter",
    numPreset: "decimal",
    nums: [
      { text: "Warehouse automation", bold: "Warehouse automation" },
      { text: "Automated receiving checks", level: 1 },
      { text: "Replace barcode scanners", level: 2 },
      { text: "Digital inspection records", level: 2 },
      { text: "Simpler picking routes", level: 1 },
      { text: "One channel for customer inquiries" },
      { text: "Switch to eco-friendly packaging" },
    ],
    hNote: "Note",
    note: "Hanging indent: the first line sticks out and the following lines are indented, so the label stands out.",
    noteBold: "Hanging indent:",
    hResults: "Results",
    hMonthly: "Monthly figures",
    pTable: "The table below shows monthly figures. The first column uses vertically merged cells, and the label in the last row spans two columns.",
    t1Head: ["Category", "Metric", "Oct", "Nov", "Dec"],
    t1Rows: [
      ["Orders", "Online orders", "41,205", "44,890", "47,312"],
      ["", "In-store orders", "38,640", "37,910", "36,450"],
      ["Customers", "New customers", "12,480", "13,920", "14,770"],
      ["", "Repeat rate", "38.2%", "41.5%", "44.9%"],
    ],
    t1Total: "Quarter total (online orders)",
    t1Caption: "Table 1. Q4 2026 monthly figures (sample data)",
    t1CaptionBold: "Table 1.",
    figCaption: "Figure 1. An image object and vector shapes",
    figCaptionBold: "Figure 1.",
    hComment: "Commentary",
    hChannel: "By channel",
    pComment: "Online orders pulled ahead of in-store orders in November. In-store orders fell, but the repeat rate kept rising. The total row adds up online orders for the quarter.",
    pCommentBold: "Online orders",
    pNext: "The next page is an appendix in landscape.",
    pNextBold: "landscape",
    hAppA: "Appendix A. Orders by channel",
    pAppA: "A new section starts here. Each section has its own paper size, orientation and margins; this one is A4 landscape with 15 mm margins.",
    pAppABold: "new section",
    t2Head: ["Channel", "Orders Oct", "Orders Nov", "Orders Dec", "Returns Oct", "Returns Nov", "Returns Dec", "QoQ"],
    t2Rows: ["Online", "In store", "Phone", "Partners"],
    t2Caption: "Table 2. Orders and returns by channel (sample data)",
    t2CaptionBold: "Table 2.",
    sample: "Sample Trading Co. sums up this quarter's revenue and costs and next quarter's plans in one document. The sentence runs on so the lines wrap and each paragraph's line spacing shows.",
    hAppB: "Appendix B. Paragraph and character formats",
    lExact: "[Line spacing exactly 18 pt]",
    lPct: "[Line spacing 200% of font size]",
    lMult: "[Line spacing multiple 2.0]",
    lSpace: "[14 pt before and after, 60 pt left and right indent]",
    lScale: "[Width 90%]",
    lSpacing: "[Spacing −5%]",
    lNormal: "[Normal]",
  },
  ja: {
    font: "Yu Gothic",
    bodyAlign: "LEFT",
    docTitle: "四半期報告書 — 2026年 第4四半期（サンプル商事）",
    header: "四半期報告書 · 2026年 第4四半期",
    title: "四半期報告書",
    sub: "2026年 第4四半期 · サンプル商事",
    meta: "作成：企画部  |  作成日：2026年11月12日  |  文書番号：SAMPLE-Q4",
    hSummary: "概要",
    body1:
      "第4四半期の売上は前四半期比18.4%増となり、オンライン注文が初めて店舗注文を上回りました。この数値は速報値ではなく確定値です。炭素排出量はCO2換算、倉庫面積はm2単位で記載しています。顧客対応時間の中央値は23分に短縮され、新しい受注システムを使う店舗も着実に増えています。",
    body1Marks: [["18.4%", "num"], ["速報値", "strike"], ["確定値", "bold"], ["CO2", "sub", 2, 3], ["m2", "sup", 1, 2], ["顧客対応時間の中央値は23分", "hl"], ["新しい受注システム", "ul"]],
    tag: "お客様のそばで、一歩先へ — Closer to customers.",
    tagA: "お客様のそばで、一歩先へ",
    tagB: "Closer to customers.",
    hHighlights: "主な成果",
    bullets: [
      { text: "オンライン販売：注文アプリを刷新し、当日配送エリアを拡大", bold: "オンライン販売" },
      { text: "注文アプリ — カートから決済までの手順を短縮", level: 1 },
      { text: "配送 — 首都圏は当日、その他の地域は翌日にお届け", level: 1 },
      { text: "店舗運営：新しい受注システムを40店舗に導入", bold: "店舗運営" },
    ],
    hNext: "次四半期の課題",
    numPreset: "decimal",
    nums: [
      { text: "物流センターの自動化", bold: "物流センターの自動化" },
      { text: "入荷検品の自動化", level: 1 },
      { text: "バーコードスキャナーの更新", level: 2 },
      { text: "検品記録の電子化", level: 2 },
      { text: "出荷動線の見直し", level: 1 },
      { text: "問い合わせ窓口の一本化" },
      { text: "環境に配慮した梱包材への切り替え" },
    ],
    hNote: "備考",
    note: "ぶら下げインデント：1行目を左に出し、2行目以降を字下げして項目名を目立たせる段落の形です。",
    noteBold: "ぶら下げインデント：",
    hResults: "実績",
    hMonthly: "月別の指標",
    pTable: "下の表は月別の指標です。1列目は縦に結合したセル、最終行の項目名は横に結合したセルです。",
    t1Head: ["区分", "指標", "10月", "11月", "12月"],
    t1Rows: [
      ["注文", "オンライン注文（件）", "41,205", "44,890", "47,312"],
      ["", "店舗注文（件）", "38,640", "37,910", "36,450"],
      ["顧客", "新規顧客（人）", "12,480", "13,920", "14,770"],
      ["", "リピート率", "38.2%", "41.5%", "44.9%"],
    ],
    t1Total: "四半期合計（オンライン注文）",
    t1Caption: "表1. 2026年 第4四半期の月別指標（例示の数値）",
    t1CaptionBold: "表1.",
    figCaption: "図1. 画像オブジェクトとベクター図形",
    figCaptionBold: "図1.",
    hComment: "解説",
    hChannel: "チャネル別の動き",
    pComment: "11月からオンライン注文が店舗注文を上回り始めました。店舗注文は減ったものの、リピート率は着実に上がっています。表の合計行は、同じ四半期のオンライン注文数を足した値です。",
    pCommentBold: "オンライン注文",
    pNext: "次のページは用紙を横向きにした付録です。",
    pNextBold: "横向き",
    hAppA: "付録A. チャネル別の注文件数",
    pAppA: "このページから新しいセクションです。セクションごとに用紙サイズ、向き、余白を設定でき、ここはA4横向き、余白15 mmです。",
    pAppABold: "新しいセクション",
    t2Head: ["チャネル", "注文 10月", "注文 11月", "注文 12月", "返品 10月", "返品 11月", "返品 12月", "前期比"],
    t2Rows: ["オンライン", "店舗", "電話", "提携先"],
    t2Caption: "表2. チャネル別の注文・返品件数（例示の数値）",
    t2CaptionBold: "表2.",
    sample: "サンプル商事は、今四半期の売上と費用、次四半期の計画を一つの文書にまとめています。文が長く続いて折り返すので、段落ごとの行間の違いがよくわかります。",
    hAppB: "付録B. 段落と文字の書式",
    lExact: "[行間 固定 18 pt]",
    lPct: "[行間 文字サイズの200%]",
    lMult: "[行間 倍数 2.0]",
    lSpace: "[段落前後 14 pt、左右インデント 60 pt]",
    lScale: "[文字幅 90%]",
    lSpacing: "[字間 −5%]",
    lNormal: "[標準]",
  },
  zh: {
    font: "Microsoft YaHei",
    docTitle: "季度报告 — 2026年第四季度（示例贸易公司）",
    header: "季度报告 · 2026年第四季度",
    title: "季度报告",
    sub: "2026年第四季度 · 示例贸易公司",
    meta: "编写：企划部  |  日期：2026年11月12日  |  文件编号：SAMPLE-Q4",
    hSummary: "摘要",
    body1:
      "第四季度销售额比上一季度增长18.4%，线上订单首次超过门店订单。以上为确定值，而非初步数据。碳排放以CO2当量计，仓库面积以m2计。客户响应时间的中位数缩短至23分钟，使用新订单系统的门店持续增加。",
    body1Marks: [["18.4%", "num"], ["线上订单", "italic"], ["初步数据", "strike"], ["确定值", "bold"], ["CO2", "sub", 2, 3], ["m2", "sup", 1, 2], ["客户响应时间的中位数缩短至23分钟", "hl"], ["新订单系统", "ul"]],
    tag: "贴近客户，先行一步 — Closer to customers.",
    tagA: "贴近客户，先行一步",
    tagB: "Closer to customers.",
    hHighlights: "主要成果",
    bullets: [
      { text: "线上销售：改版订购应用，扩大当日送达范围", bold: "线上销售" },
      { text: "订购应用 — 从购物车到结账的步骤更少", level: 1 },
      { text: "配送 — 首都圈当日达，其他地区次日达", level: 1 },
      { text: "门店运营：40家门店上线新订单系统", bold: "门店运营" },
    ],
    hNext: "下季度任务",
    numPreset: "decimal",
    nums: [
      { text: "物流中心自动化", bold: "物流中心自动化" },
      { text: "入库检验自动化", level: 1 },
      { text: "更换条码扫描器", level: 2 },
      { text: "检验记录电子化", level: 2 },
      { text: "优化出库动线", level: 1 },
      { text: "整合客户咨询渠道" },
      { text: "改用环保包装材料" },
    ],
    hNote: "备注",
    note: "悬挂缩进：首行向左突出，其余各行缩进，使项目名称更醒目。",
    noteBold: "悬挂缩进：",
    hResults: "业绩",
    hMonthly: "月度指标",
    pTable: "下表为月度指标。第一列为纵向合并的单元格，最后一行的名称为横向合并的单元格。",
    t1Head: ["分类", "指标", "10月", "11月", "12月"],
    t1Rows: [
      ["订单", "线上订单（笔）", "41,205", "44,890", "47,312"],
      ["", "门店订单（笔）", "38,640", "37,910", "36,450"],
      ["客户", "新客户（人）", "12,480", "13,920", "14,770"],
      ["", "复购率", "38.2%", "41.5%", "44.9%"],
    ],
    t1Total: "季度合计（线上订单）",
    t1Caption: "表1. 2026年第四季度月度指标（示例数据）",
    t1CaptionBold: "表1.",
    figCaption: "图1. 图片对象与矢量图形",
    figCaptionBold: "图1.",
    hComment: "解读",
    hChannel: "各渠道走势",
    pComment: "从11月起，线上订单开始超过门店订单。门店订单有所减少，但复购率稳步上升。表中合计行为本季度线上订单数之和。",
    pCommentBold: "线上订单",
    pNext: "下一页是横向排版的附录。",
    pNextBold: "横向",
    hAppA: "附录A. 各渠道订单数",
    pAppA: "从本页起为新的分节。每个分节可单独设置纸张大小、方向和页边距，本节为A4横向，页边距15 mm。",
    pAppABold: "新的分节",
    t2Head: ["渠道", "订单 10月", "订单 11月", "订单 12月", "退货 10月", "退货 11月", "退货 12月", "环比"],
    t2Rows: ["线上", "门店", "电话", "合作方"],
    t2Caption: "表2. 各渠道订单与退货数（示例数据）",
    t2CaptionBold: "表2.",
    sample: "示例贸易公司把本季度的收入、成本和下季度计划整理在一份文档中。句子较长会自动换行，因此能清楚看到每个段落的行距差异。",
    hAppB: "附录B. 段落与字符格式",
    lExact: "[行距 固定值 18 pt]",
    lPct: "[行距 字号的200%]",
    lMult: "[行距 多倍 2.0]",
    lSpace: "[段前段后 14 pt，左右缩进 60 pt]",
    lScale: "[字宽 90%]",
    lSpacing: "[字距 −5%]",
    lNormal: "[常规]",
  },
};
