/* ================================
   基本セットアップ
================================= */

// マップ
let map;

// 現在地マーカー
let userMarker;
let userHeading = 0;

// 現在地座標
let currentLat = null;
let currentLng = null;

// ルート表示（青線）
let routeLine = null;

// デモ走行用インデックス
let demoIndex = 0;
let demoTimer = null;

// OSRM ルートデータ
let osrmRoute = null;
let osrmInstructions = [];

// 音声読み上げ設定
let speech = window.speechSynthesis;

// ナビ中フラグ
let isNavigating = false;
let isDemo = false;


/* ================================
   マップを初期化
================================= */
function initMap() {
    map = L.map('map', {
        zoomControl: true,
        zoom: 16,
        center: [33.5902, 130.4017] // 福岡（初期位置）
    });

    // 通常マップ
    const normalLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
    }).addTo(map);

    // 衛星写真
    const satelliteLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        subdomains:['mt0','mt1','mt2','mt3']
    });

    // 切替ボタン
    document.getElementById("btn-normal-map").onclick = () => {
        map.addLayer(normalLayer);
        map.removeLayer(satelliteLayer);
    };
    document.getElementById("btn-satellite").onclick = () => {
        map.addLayer(satelliteLayer);
        map.removeLayer(normalLayer);
    };

    /* 現在地を取得 */
    watchCurrentLocation();
}

initMap();


/* ================================
   現在地追従（GPS）
================================= */
function watchCurrentLocation() {
    if (!navigator.geolocation) {
        alert("GPSが使えません。");
        return;
    }

    navigator.geolocation.watchPosition(pos => {
        currentLat = pos.coords.latitude;
        currentLng = pos.coords.longitude;
        userHeading = pos.coords.heading ?? userHeading;

        updateUserMarker();

        // 追従中であれば中心へ
        if (!isNavigating) {
            map.setView([currentLat, currentLng]);
        }

        // ナビ中 → リルートチェック
        if (isNavigating && !isDemo) {
            checkReroute();
        }

    }, err => {
        console.error(err);
    }, {
        enableHighAccuracy: true,
        maximumAge: 0
    });
}


/* ================================
   現在地マーカー更新（赤い三角）
================================= */
function updateUserMarker() {
    if (!currentLat || !currentLng) return;

    const icon = L.divIcon({
        className: "user-icon",
        html: `
            <div class="triangle" style="transform: rotate(${userHeading}deg);"></div>
        `,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });

    if (!userMarker) {
        userMarker = L.marker([currentLat, currentLng], { icon }).addTo(map);
    } else {
        userMarker.setLatLng([currentLat, currentLng]);
        userMarker.setIcon(icon);
    }
}


/* ================================
   現在地センターボタン
================================= */
document.getElementById("locate-btn").onclick = () => {
    if (currentLat && currentLng) {
        map.setView([currentLat, currentLng], 18);
    }
};
/* ================================
   ルート検索ボタン
================================= */
document.getElementById("btn-search-route").onclick = async () => {
    const startText = document.getElementById("start-input").value;
    const endText   = document.getElementById("end-input").value;

    if (!startText || !endText) {
        alert("出発地と目的地を入力してください。");
        return;
    }

    const start = await geocode(startText);
    const end   = await geocode(endText);

    if (!start || !end) {
        alert("場所が見つかりません。");
        return;
    }

    requestRoute(start, end);
};


/* ================================
   ジオコーダ（無料：Nominatim）
================================= */
async function geocode(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.length === 0) return null;

    return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon)
    };
}


/* ================================
   OSRM ルート検索
================================= */
async function requestRoute(start, end) {
    const noHighway = document.getElementById("no-highway").checked;

    const url = `https://router.project-osrm.org/route/v1/driving/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson&steps=true${noHighway ? "&exclude=motorway" : ""}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.routes) {
        alert("ルートが取得できません。");
        return;
    }

    osrmRoute = data.routes[0];

    osrmInstructions = [];
    osrmRoute.legs[0].steps.forEach(step => {
        osrmInstructions.push({
            distance: step.distance,
            name: step.name,
            instruction: step.maneuver.instruction,
            maneuver: step.maneuver
        });
    });

    drawRoute(osrmRoute);
}


/* ================================
   ルートを青線で描画
================================= */
function drawRoute(route) {
    const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);

    if (routeLine) {
        map.removeLayer(routeLine);
    }

    routeLine = L.polyline(coords, {
        color: "blue",
        weight: 5
    }).addTo(map);

    map.fitBounds(routeLine.getBounds());
}


/* ================================
   距離表示フォーマット
================================= */
function formatDistance(m) {
    if (m >= 1000) {
        return (Math.round((m/1000)*10) / 10) + "km";
    } else {
        return Math.round(m / 10) * 10 + "m";
    }
}


/* ================================
   分岐方向を判定するロジック
   modifier = left / right / slight / sharp ...
================================= */
function getDirection(mod) {
    switch (mod) {
        case "right":        return "右方向です";
        case "left":         return "左方向です";
        case "slight right": return "斜め右方向です";
        case "slight left":  return "斜め左方向です";
        case "sharp right":  return "大きく右方向です";
        case "sharp left":   return "大きく左方向です";
        case "uturn":        return "Uターンです";
        default:             return "直進です";
    }
}


/* ================================
   案内文生成（分岐・合流・IC/JCT対応）
================================= */
function parseInstruction(step) {
    const m = step.maneuver;
    const mod = m.modifier;
    const name = step.name ? `${step.name}を` : "";

    let dir = "";

    switch (m.type) {

        /* ---- 通常の交差点 ---- */
        case "turn":
            dir = getDirection(mod);
            break;

        case "u-turn":
            dir = "Uターンしてください";
            break;

        /* ---- 高速道路・分岐 ---- */
        case "merge":
            // 本線合流
            dir = "本線に合流します";
            break;

        case "fork":
            // 分岐は左右が非常に重要
            dir = `${getDirection(mod).replace("です", "")}方向の分岐です`;
            break;

        case "ramp":
            // 高速入口・出口
            if (m.modifier === "right" || m.modifier === "left") {
                dir = `${getDirection(mod).replace("です", "")}方向のランプに入ります`;
            } else {
                dir = "ランプに入ります";
            }
            break;

        case "exit":
            // 高速出口
            dir = `${getDirection(mod).replace("です", "")}方向の出口です`;
            break;

        case "motorway_junction":
            // JCT / IC の分岐
            dir = `${getDirection(mod).replace("です", "")}方向の分岐（IC / JCT）です`;
            break;

        /* ---- ラウンドアバウト ---- */
        case "roundabout":
            dir = `ラウンドアバウト ${step.maneuver.exit} 番目で出ます`;
            break;

        /* ---- デフォルト ---- */
        default:
            dir = "そのまま進みます";
    }

    return `${name}${dir}`;
}


/* ================================
   音声読み上げ
================================= */
function readText(text) {
    const msg = new SpeechSynthesisUtterance(text);
    speech.speak(msg);
}
/* ==========================================================
   方向判定（右/左/直進/斜め/大きく/Uターン/高速系/分岐）
   ========================================================== */

function classifyDirection(inst) {
    const t = inst.instruction.toLowerCase();

    if (t.includes("u-turn")) return "uturn";

    if (t.includes("sharp right")) return "sharp-right";
    if (t.includes("sharp left")) return "sharp-left";

    if (t.includes("bear right")) return "slight-right";
    if (t.includes("bear left")) return "slight-left";

    if (t.includes("turn right")) return "right";
    if (t.includes("turn left")) return "left";

    if (t.includes("straight")) return "straight";

    // 高速系
    if (t.includes("motorway")) {
        if (t.includes("enter") || t.includes("ramp")) return "highway-enter";
        if (t.includes("exit")) return "highway-exit";
    }

    if (t.includes("merge")) return "merge";
    if (t.includes("junction")) return "junction";

    if (t.includes("interchange")) return "ic";
    if (t.includes("service area") || t.includes("parking area")) return "sapa";

    return "none";
}

/* ==========================================================
   交差点名抽出（onto / toward などから取得）
   ========================================================== */

function extractIntersectionName(text) {
    let name = "";

    const onto = text.indexOf("onto ");
    if (onto !== -1) {
        name = text.substring(onto + 5).trim();
    }

    const toward = text.indexOf("toward ");
    if (toward !== -1) {
        name = text.substring(toward + 7).trim();
    }

    // 不要な句読点・括弧など除去
    name = name.replace(/[,.;]/g, "").trim();

    return name;
}

/* ==========================================================
   距離表現（表示・音声共通）
   ========================================================== */

function formatDistance(m) {
    if (m < 1000) {
        const rounded = Math.round(m / 10) * 10;
        return `${rounded}メートル`;
    } else {
        const km = m / 1000;
        const rounded = Math.round(km * 10) / 10;
        return `${rounded}キロ`;
    }
}

/* ==========================================================
   direction → 表示用の自然文
   ========================================================== */

function displayDirectionText(dir, name) {
    const place = name ? `${name}を` : "";

    switch (dir) {
        case "right": return `${place}右方向です。`;
        case "left": return `${place}左方向です。`;
        case "slight-right": return `${place}斜め右方向です。`;
        case "slight-left": return `${place}斜め左方向です。`;
        case "sharp-right": return `${place}大きく右に曲がります。`;
        case "sharp-left": return `${place}大きく左に曲がります。`;
        case "straight": return `${place}直進です。`;
        case "uturn": return `${place}Uターンです。`;
        case "highway-enter": return `${place}高速道路に入ります。`;
        case "highway-exit": return `${place}高速道路から降ります。`;
        case "merge": return `${place}本線に合流します。`;
        case "junction": return `${place}分岐があります。`;
        case "sapa": return `${place}サービスエリア付近です。`;
        case "ic": return `${place}インターチェンジ方向です。`;
        default: return `案内があります。`;
    }
}

/* ==========================================================
   direction → 音声読み上げ用の自然文
   ========================================================== */

function voiceDirectionText(dir, distText, name) {
    const place = name ? `${name}を` : "";

    switch (dir) {
        case "right": return `あと${distText}で、${place}右に曲がります。`;
        case "left": return `あと${distText}で、${place}左に曲がります。`;
        case "slight-right": return `あと${distText}で、${place}斜め右方向です。`;
        case "slight-left": return `あと${distText}で、${place}斜め左方向です。`;
        case "sharp-right": return `あと${distText}で、${place}大きく右に曲がります。`;
        case "sharp-left": return `あと${distText}で、${place}大きく左に曲がります。`;
        case "straight": return `あと${distText}で、${place}直進です。`;
        case "uturn": return `あと${distText}でUターンです。`;
        case "highway-enter": return `あと${distText}で${place}高速道路に入ります。`;
        case "highway-exit": return `あと${distText}で${place}高速道路を降ります。`;
        case "merge": return `あと${distText}で${place}本線に合流します。`;
        case "junction": return `あと${distText}で${place}分岐があります。`;
        case "sapa": return `あと${distText}で${place}サービスエリア付近です。`;
        case "ic": return `あと${distText}で${place}インターチェンジ方向です。`;
        default: return `あと${distText}です。`;
    }
}

/* ==========================================================
   ナビ表示（ナビビューの上部バー更新）
   ========================================================== */

function updateNavigationUI(step, dist) {
    const dir = classifyDirection(step);
    const name = extractIntersectionName(step.instruction);
    const distText = formatDistance(dist);

    // 表示用文章
    const displayText = `次 - ${distText}：${displayDirectionText(dir, name)}`;

    document.getElementById("nav-distance").textContent = distText;
    document.getElementById("nav-turn").textContent = displayText;

    // 音声読み上げ
    speak(voiceDirectionText(dir, distText, name));
}

/* ==========================================================
   音声読み上げ (iPhone/Android/Windows/Mac/Linux/ChromeOS)
   ========================================================== */

function speak(text) {
    try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "ja-JP";
        speechSynthesis.speak(u);
    } catch (e) {
        console.warn("音声読み上げ非対応:", e);
    }
}
/* ==========================================================
   現在地マーカー（三角 / 進行方向に回転）
   ========================================================== */

let userMarker = null;
let userHeading = 0;

function createUserMarker(lat, lng) {
    const icon = L.divIcon({
        html: `
            <div class="user-marker" style="
                width: 0;
                height: 0;
                border-left: 12px solid transparent;
                border-right: 12px solid transparent;
                border-bottom: 25px solid red;
                transform: rotate(${userHeading}deg);
                position: relative;
            ">
                <div style="
                    width: 14px;
                    height: 8px;
                    background: white;
                    position: absolute;
                    bottom: -2px;
                    left: 50%;
                    transform: translateX(-50%);
                    border-radius: 5px;
                "></div>
            </div>
        `,
        className: "",
        iconSize: [0, 0]
    });

    return L.marker([lat, lng], { icon }).addTo(map);
}

function updateUserMarkerRotation(heading) {
    userHeading = heading;
    if (!userMarker) return;

    const el = userMarker.getElement().querySelector(".user-marker");
    if (el) el.style.transform = `rotate(${userHeading}deg)`;
}

/* ==========================================================
   GPS追跡（通常案内）
   ========================================================== */

let watchID = null;
let isFollowing = false;

function startGPSFollow() {
    if (watchID) navigator.geolocation.clearWatch(watchID);

    watchID = navigator.geolocation.watchPosition((pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const heading = pos.coords.heading || userHeading;

        updateUserMarker(lat, lng, heading);

        if (isFollowing) {
            map.setView([lat, lng], map.getZoom(), { animate: true });
        }

        handleNavigationProgress(lat, lng, heading);

    }, console.warn, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
    });
}

function updateUserMarker(lat, lng, heading) {
    if (!userMarker) {
        userMarker = createUserMarker(lat, lng);
    } else {
        userMarker.setLatLng([lat, lng]);
    }
    updateUserMarkerRotation(heading);
}


/* ==========================================================
   ルートデータ格納
   ========================================================== */

let routeCoordinates = [];
let currentStepIndex = 0;
let routeLayer = null;


/* ==========================================================
   ナビ開始（通常案内・デモ走行共通）
   ========================================================== */

function startNavigation(route) {
    routeCoordinates = route;
    currentStepIndex = 0;

    enterNavigationView();

    isFollowing = true;

    // ルート（青線）を描画
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.polyline(routeCoordinates, { color: "blue", weight: 5 }).addTo(map);

    // 通常案内なら GPS開始、デモなら simulateRoute()
}

/* ==========================================================
   ナビビューへの切り替え
   ========================================================== */

function enterNavigationView() {
    document.body.classList.add("nav-mode");
    document.getElementById("nav-view").style.display = "block";
}

function exitNavigationView() {
    document.body.classList.remove("nav-mode");
    document.getElementById("nav-view").style.display = "none";

    isFollowing = false;
    currentStepIndex = 0;

    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = null;
}


/* ==========================================================
   ナビ進行処理（次のステップまで距離を計算）
   ========================================================== */

function handleNavigationProgress(lat, lng, heading) {
    if (!routeCoordinates.length) return;

    // 現在の次のターン地点
    const nextPoint = routeCoordinates[currentStepIndex];
    const dist = map.distance([lat, lng], nextPoint);

    // 案内UIを更新（その3の関数）
    updateNavigationUI(navigationSteps[currentStepIndex], dist);

    // 一定距離以下ならステップを進める
    if (dist < 20) {
        currentStepIndex++;

        // ゴール
        if (currentStepIndex >= routeCoordinates.length - 1) {
            speak("目的地に到着しました。案内を終了します。");
            exitNavigationView();
            return;
        }
    }

    // 進行方向計算
    updateUserMarkerRotation(heading);

    // 道路外れ → リルート
    checkReroute(lat, lng);
}

/* ==========================================================
   リルート処理（道路から外れた場合）
   ========================================================== */

function checkReroute(lat, lng) {
    if (currentStepIndex <= 1) return; 

    const dist = map.distance([lat, lng], routeCoordinates[currentStepIndex]);

    // 30m以上外れたらリルート
    if (dist > 30) {
        speak("ルートから外れました。経路を再検索します。");

        fetchRoute(lat, lng, destination.lat, destination.lng).then(route => {
            startNavigation(route);
        });
    }
}

/* ==========================================================
   デモ走行モード（ルート上を動かす）
   ========================================================== */

function simulateRoute() {
    let i = 0;
    isFollowing = true;

    function step() {
        if (i >= routeCoordinates.length) {
            speak("デモ走行が終了しました。");
            exitNavigationView();
            return;
        }

        const [lat, lng] = routeCoordinates[i];
        const next = routeCoordinates[i + 1] || [lat, lng];

        // 方向計算 → 三角マーカー回転
        const heading = calculateHeading(lat, lng, next[0], next[1]);

        updateUserMarker(lat, lng, heading);

        map.setView([lat, lng], 18);

        handleNavigationProgress(lat, lng, heading);

        i++;
        setTimeout(step, 600); // 動く速度（調整可）
    }

    step();
}

function calculateHeading(lat1, lng1, lat2, lng2) {
    const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
    const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);

    const brng = Math.atan2(y, x);
    return (brng * 180) / Math.PI;
}

/* ==========================================================
   停止ボタン
   ========================================================== */

document.getElementById("nav-stop").addEventListener("click", () => {
    speak("案内を終了します。");
    exitNavigationView();
});
