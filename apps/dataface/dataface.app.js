const SETTINGS = {
  units: "imperial", // "imperial" shows ° only, internally °F; switch to "metric" if you want °C later
  lat: 45.5152,
  lon: -122.6784,

  // Style
  hiColor: "#ff0000",
  loColor: "#00ffff",
  txtColor: "#ffffff",
  bgColor: "#000000",
  sidePad: 6,

  // Timers
  tickMs: 1000,
  infoRefreshMs: 5 * 60 * 1000,
};

let layout;
let drawInterval;
let infoInterval;
let weather = { tHi: null, t: null, tLo: null, cond: "", updated: 0 };
let sun = { sr: "--:--", ss: "--:--" };

// ---- Date/time formatting ----
function two(n) {
  return (n < 10 ? "0" : "") + n;
}
function fmtTimeHMS(d) {
  return (
    two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds())
  );
}
function fmtDate(d) {
  var ddd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  var mmm = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getMonth()];
  return ddd + ", " + mmm + " " + two(d.getDate());
}
function toHM(d) {
  return two(d.getHours()) + ":" + two(d.getMinutes());
}

// ---- Steps ----
function getSteps() {
  try {
    // Primary: Health API daily tally
    var hs = Bangle.getHealthStatus && Bangle.getHealthStatus("day");
    if (hs && hs.steps != null) return hs.steps | 0;

    // Some firmwares expose a different shape
    if (hs && hs.today && hs.today.steps != null) return hs.today.steps | 0;

    // Legacy fallback (older firmwares/widgets may maintain this)
    if (Bangle.steps != null) return Bangle.steps | 0;
  } catch (e) {
    /* ignore */
  }
  return 0;
}

// ---- Cache ----
function saveCache() {
  try {
    require("Storage").writeJSON("wf_cache.json", { weather, sun }, 1);
  } catch (e) {}
}
function loadCache() {
  try {
    var c = require("Storage").readJSON("wf_cache.json", 1);
    if (c && c.weather) weather = c.weather;
    if (c && c.sun) sun = c.sun;
  } catch (e) {}
}

// ---- Sunrise/Sunset (local) ----
function computeSunLocal() {
  try {
    var SunCalc = require("suncalc");
    var t = SunCalc.getTimes(new Date(), SETTINGS.lat, SETTINGS.lon);
    sun.sr = toHM(t.sunrise);
    sun.ss = toHM(t.sunset);
  } catch (e) {}
}

// ---- Weather ingestion ----
function KtoF(k) {
  return Math.round(((k - 273.15) * 9) / 5 + 32);
}
function KtoC(k) {
  return Math.round(k - 273.15);
}
function applyGBWeather(w) {
  var hi =
    w.hi != null && isFinite(w.hi)
      ? SETTINGS.units === "imperial"
        ? KtoF(w.hi)
        : KtoC(w.hi)
      : null;
  var lo =
    w.lo != null && isFinite(w.lo)
      ? SETTINGS.units === "imperial"
        ? KtoF(w.lo)
        : KtoC(w.lo)
      : null;
  var tt =
    w.temp != null && isFinite(w.temp)
      ? SETTINGS.units === "imperial"
        ? KtoF(w.temp)
        : KtoC(w.temp)
      : null;
  weather.tHi = hi;
  weather.tLo = lo;
  weather.t = tt;
  weather.cond = w.txt || "";
  weather.updated = Date.now();
  updateWeatherLabels();
  saveCache();
}
function tryWeatherFromStorage() {
  try {
    var s = require("Storage").readJSON("weather.json", 1);
    if (!s) return false;

    // Breezy writes: { t:"weather", weather:{ ... } }
    var w = s.weather || s;

    // Robust conversion for Kelvin/°C → desired units
    function toUnit(x) {
      if (x == null || !isFinite(x)) return null;
      // Heuristics:
      //  - >200 → probably Kelvin
      //  -  - if imperial → F = (K-273.15)*9/5+32
      //  -  - if metric   → C = K-273.15
      //  - <= 200 → already C/F-ish
      if (x > 200) {
        return SETTINGS.units === "imperial"
          ? Math.round(((x - 273.15) * 9) / 5 + 32)
          : Math.round(x - 273.15);
      } else {
        // If it's already C/F, just convert if needed
        return SETTINGS.units === "imperial"
          ? Math.round((x * 9) / 5 + 32) // assume C → F
          : Math.round(x); // assume C already
      }
    }

    // Pull fields from Breezy’s payload
    var t = w.temp; // Kelvin (Breezy)
    var tmax = w.hi != null ? w.hi : w.tmax != null ? w.tmax : undefined;
    var tmin = w.lo != null ? w.lo : w.tmin != null ? w.tmin : undefined;
    var desc = w.txt || w.desc || "";

    var got = false;
    var tt = toUnit(t);
    var thi = toUnit(tmax);
    var tlo = toUnit(tmin);

    if (tt != null) {
      weather.t = tt;
      got = true;
    }
    if (thi != null) {
      weather.tHi = thi;
      got = true;
    }
    if (tlo != null) {
      weather.tLo = tlo;
      got = true;
    }

    weather.cond = desc;
    weather.updated = Date.now();

    updateWeatherLabels();
    return got;
  } catch (e) {
    return false;
  }
}
Bangle.on("GB", function (msg) {
  if (msg.t === "weather" && msg.weather) {
    applyGBWeather(msg.weather);
    return;
  }
});

// ---- Simple vector weather icons (no image files) ----
function iconKind(desc) {
  if (!desc) return "sun";
  var s = desc.toLowerCase();
  if (s.indexOf("thunder") >= 0 || s.indexOf("storm") >= 0) return "storm";
  if (
    s.indexOf("rain") >= 0 ||
    s.indexOf("drizzle") >= 0 ||
    s.indexOf("shower") >= 0
  )
    return "rain";
  if (s.indexOf("snow") >= 0 || s.indexOf("sleet") >= 0) return "snow";
  if (s.indexOf("fog") >= 0 || s.indexOf("mist") >= 0 || s.indexOf("haze") >= 0)
    return "fog";
  if (s.indexOf("cloud") >= 0 || s.indexOf("overcast") >= 0) return "cloud";
  if (s.indexOf("clear") >= 0 || s.indexOf("sun") >= 0) return "sun";
  return "cloud";
}
function drawWeatherIcon(kind, x, y, w, h) {
  // draw within {x,y,w,h}; keep it simple and readable
  var cx = x + (w >> 1),
    cy = y + (h >> 1),
    r = Math.min(w, h) / 3;
  g.setColor(SETTINGS.txtColor);
  if (kind === "sun") {
    g.drawCircle(cx, cy, r);
    var i = 0,
      rays = 8,
      len = r + 6;
    for (i = 0; i < rays; i++) {
      var a = (i * Math.PI * 2) / rays;
      g.drawLine(
        cx + Math.cos(a) * r,
        cy + Math.sin(a) * r,
        cx + Math.cos(a) * len,
        cy + Math.sin(a) * len
      );
    }
  } else if (kind === "cloud") {
    g.fillCircle(cx - 8, cy, r);
    g.fillCircle(cx + 2, cy - 4, r * 0.9);
    g.fillCircle(cx + 10, cy, r * 0.8);
    // g.fillRect(cx - 16, cy, cx + 16, cy + 10);
  } else if (kind === "rain") {
    drawWeatherIcon("cloud", x, y, w, h - 8);
    var j;
    for (j = -1; j <= 1; j++) {
      g.drawLine(cx + j * 8, cy + 8, cx + j * 8 - 2, cy + 14);
    }
  } else if (kind === "snow") {
    drawWeatherIcon("cloud", x, y, w, h - 8);
    var k;
    for (k = -1; k <= 1; k++) {
      g.drawLine(cx + k * 8, cy + 8, cx + k * 8, cy + 14);
      g.drawLine(cx + k * 8 - 3, cy + 11, cx + k * 8 + 3, cy + 11);
    }
  } else if (kind === "fog") {
    g.drawLine(x + 2, cy - 6, x + w - 2, cy - 6);
    g.drawLine(x + 4, cy - 1, x + w - 4, cy - 1);
    g.drawLine(x + 6, cy + 4, x + w - 6, cy + 4);
  } else if (kind === "storm") {
    drawWeatherIcon("cloud", x, y, w, h - 8);
    g.drawLine(cx, cy + 6, cx - 6, cy + 16);
    g.drawLine(cx - 2, cy + 12, cx + 6, cy + 2);
  }
}

// ---- Layout ----
function makeLayout() {
  var Layout = require("Layout");

  var timeItem = {
    type: "txt",
    id: "time",
    font: "Vector:40",
    label: fmtTimeHMS(new Date()),
    halign: 0, // centered horizontally
    valign: -1, // top-aligned
    col: SETTINGS.txtColor,
    pad: {
      top: 12,
      bottom: 0,
      left: SETTINGS.sidePad,
      right: SETTINGS.sidePad,
    },
    fillx: 1,
    filly: 0,
  };

  var weatherRow = {
    type: "h",
    id: "weatherRow",
    pad: SETTINGS.sidePad,
    c: [
      {
        // LEFT: Hi / Low
        type: "v",
        id: "leftCol",
        fillx: 1,
        c: [
          {
            type: "txt",
            id: "hi",
            font: "Vector:20",
            halign: -1,
            label: "--°",
            col: SETTINGS.hiColor,
          },
          {
            type: "txt",
            id: "lo",
            font: "Vector:20",
            halign: -1,
            label: "--°",
            col: SETTINGS.loColor,
          },
        ],
      },
      {
        // CENTER: Current (big)
        type: "custom",
        id: "curBox",
        fillx: 1,
        render: function (l) {
          var unit = "°";
          var cur = (weather.t == null ? "--" : weather.t) + unit;
          var min = 20,
            max = 60,
            best = min;
          while (min <= max) {
            var mid = (min + max) >> 1;
            g.setFont("Vector", mid);
            var w = g.stringWidth(cur);
            var h = mid;
            if (w <= l.w - 2 && h <= l.h - 2) {
              best = mid;
              min = mid + 1;
            } else max = mid - 1;
          }
          g.setFont("Vector", best);
          g.setColor(SETTINGS.txtColor);
          g.setFontAlign(0, 0);
          g.drawString(cur, l.x + (l.w >> 1), l.y + (l.h >> 1));
        },
      },
      {
        // RIGHT: Sunrise / Sunset (times only)
        type: "v",
        id: "rightCol",
        fillx: 1,
        c: [
          {
            type: "txt",
            id: "sr",
            font: "Vector:18",
            halign: 1,
            label: "--:--",
          },
          {
            type: "txt",
            id: "ss",
            font: "Vector:18",
            halign: 1,
            label: "--:--",
          },
        ],
      },
    ],
  };

  // NEW FOOTER: left = weather icon (image), right = steps (right-aligned)
  var footerRow = {
    type: "h",
    id: "footer",
    pad: SETTINGS.sidePad,
    c: [
      {
        // icon cell
        type: "custom",
        id: "wicon",
        fillx: 1,
        height: 28,
        render: function (l) {
          var kind = iconKind(weather.cond);
          // draw in a square inside l
          var s = Math.min(l.w, l.h);
          drawWeatherIcon(kind, l.x, l.y, s, s);
        },
      },
      {
        // steps right-aligned (no emoji)
        type: "txt",
        id: "steps",
        font: "6x8:2",
        label: getSteps(),
        halign: 1,
        fillx: 1,
      },
    ],
  };

  layout = new Layout(
    {
      type: "v",
      c: [
        timeItem,
        {
          type: "txt",
          id: "date",
          font: "6x8:2",
          label: fmtDate(new Date()),
          pad: 2,
          halign: 0,
        },
        weatherRow,
        footerRow,
      ],
    },
    { lazy: true }
  );

  g.setBgColor(SETTINGS.bgColor);
  g.setColor(SETTINGS.txtColor);
  g.clear();
  layout.render();
}

function updateWeatherLabels() {
  var unit = "°";
  if (!layout) return;
  layout.hi.label = (weather.tHi == null ? "--" : weather.tHi) + unit;
  layout.lo.label = (weather.tLo == null ? "--" : weather.tLo) + unit;
  layout.sr.label = sun.sr || "--:--";
  layout.ss.label = sun.ss || "--:--";
  layout.steps.label = getSteps();
  layout.render();
}

// ---- Draw loop & power handling ----
function drawTick() {
  if (!layout) return;
  layout.time.label = fmtTimeHMS(new Date());
  layout.date.label = fmtDate(new Date());
  layout.steps.label = getSteps();
  layout.render();
}
function onLCD(on) {
  if (on) {
    drawTick();
    if (!drawInterval) drawInterval = setInterval(drawTick, SETTINGS.tickMs);
  } else {
    if (drawInterval) {
      clearInterval(drawInterval);
      drawInterval = undefined;
    }
  }
}
Bangle.on("step", function () {
  drawTick();
});

// ---- Init ----
Bangle.setUI("clock");
g.reset();
g.setBgColor(SETTINGS.bgColor);
g.setColor(SETTINGS.txtColor);
try {
  Bangle.loadWidgets();
  Bangle.drawWidgets();
} catch (e) {}

function startTick() {
  if (drawInterval) clearInterval(drawInterval);
  // draw right now
  drawTick();
  // then align to next second boundary
  var ms = 1000 - (Date.now() % 1000);
  setTimeout(function () {
    drawTick();
    drawInterval = setInterval(drawTick, SETTINGS.tickMs);
  }, ms);
}

loadCache();
computeSunLocal();
makeLayout();
updateWeatherLabels();
startTick();

// periodic refreshers
infoInterval = setInterval(function () {
  tryWeatherFromStorage();
  computeSunLocal();
  saveCache();
}, SETTINGS.infoRefreshMs);

// power events
Bangle.on("lcdPower", onLCD);
setWatch(
  function () {
    // If the screen is off, wake it instead of launching
    if (!Bangle.isLCDOn()) {
      Bangle.setLCDPower(1);
      return;
    }
    // Otherwise open the launcher
    Bangle.showLauncher();
  },
  BTN1,
  { repeat: true, edge: "rising", debounce: 50 }
);

// initial kick
setTimeout(function () {
  tryWeatherFromStorage();
  computeSunLocal();
  updateWeatherLabels();
  saveCache();
}, 1500);

E.on("kill", function () {
  if (drawInterval) clearInterval(drawInterval);
  if (infoInterval) clearInterval(infoInterval);
});
