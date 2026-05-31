import "https://cdn.jsdelivr.net/npm/iuai@0.6.2/iuai.js";
import "https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.js";
import "https://unpkg.com/@turf/turf@7.0.0/turf.min.js";

import citiesJson from "./cities.json" with { type: "json" };

const { elem, style, getElem } = iuai;

initApp();

let map, mapLoaded, cursor, distanceActive;

function loadResources(mapStyle) {
  const { mode } = getHashParams();
  mapLoaded = new Ready();
  cursor = { action: "pointer", idle: "" };
  distanceActive = new Subject(false);

  initMap(mapStyle);

  if (mode === "cities") initCitiesLayer();

  if (mode === "bairros") initBairrosDeFortaleza();

  if (mode === "municipios") initMunicipiosDoCeara();

  if (mode === "microrregiao") initMicrorregioesDoCearaLayer();

  initPlaceHandlers();

  initDistanceMeasure();
}
loadResources();

// zoom 4 começa a aparecer nome de cidade
// zoom 8 os nomes tomam lugar dos pontos... o ponto precisa de um offset

async function initMunicipiosDoCeara() {
  const sourceData = await getMunicipiosSourceData();
  initAreaLayer({
    sourceData,
    layerId: "municipios",
    color: [
      "interpolate",
      ["linear"],
      ["to-number", ["get", "idh"]],
      0.55,
      "hsl(0,50%,50%)",
      0.6,
      "hsl(60,50%,50%)",
      0.65,
      "hsl(120,50%,50%)",
      0.7,
      "hsl(240,50%,50%)",
      0.75,
      "hsl(270,50%,25%)",
    ],
    zoom: 3,
    onclick: (e) =>
      addPopup(
        e.lngLat,
        pick(e.features[0].properties, [
          "name",
          "populacao",
          "area",
          "densidade",
          "idh",
          "gentilico",
          "microrregiao",
          "mesorregiao",
          "regiao-imediata",
          "regiao-intermediaria",
        ]),
      ),
  });
}

async function initBairrosDeFortaleza() {
  const [sourceData, bairros] = await Promise.all([
    getNotepadeData("bairrosdefortaleza"),
    getNotepadeData("bairrosdefortalezadados"),
  ]);
  const formatBairro = (b) => ({
    codigo: b.code_ibge,
    regional: b.ser,
    IDH: brNumber(b.idh_2010),
    area: brNumber(b.area_km2),
    populacao: brNumber(b.populacao_2022_ibge),
    densidade: brNumber(b.densidade_2022_ibge_hab_km2),
  });
  sourceData.features.map((a) => {
    let x = bairros.find(
      (b) => b.code_ibge === a.properties["Código do  Bairro"],
    );
    if (!x) return console.log(a);
    Object.assign(a.properties, formatBairro(x));
  });
  console.table(
    sourceData.features
      .map((a) =>
        pick(a.properties, ["Nome", "IDH", "area", "populacao", "densidade"]),
      )
      .sort((a, b) => a.Nome.toLowerCase().localeCompare(b.Nome.toLowerCase())),
  );
  initAreaLayer({
    sourceData,
    layerId: "bairros",
    // color: colorByProp(sourceData, "Regional Atual"), //"#627BC1",
    // color: "#627BC1",
    color: [
      "interpolate",
      ["linear"],
      ["get", "IDH"],
      0.12,
      "hsl(0,50%,50%)",
      0.3,
      "hsl(60,50%,50%)",
      0.5,
      "hsl(120,50%,50%)",
      0.7,
      "hsl(240,50%,50%)",
      0.95,
      "hsl(270,50%,50%)",
    ],
    zoom: 8,
    onclick: (e) =>
      addPopup(
        e.lngLat,
        pick(e.features[0].properties, [
          "Nome",
          "codigo",
          "regional",
          "IDH",
          "area",
          "populacao",
          "densidade",
        ]),
      ),
  });
}

async function getMunicipiosSourceData() {
  const [sourceData, ibge] = await Promise.all([
    getNotepadeData("municipiosdoceara"),
    getNotepadeData("ibgemunicipios"),
  ]);
  console.log({ sourceData, ibge });
  sourceData.features.forEach(
    (b) =>
      (b.properties = {
        ...ibge.find((a) => a.id == b.properties.id),
        ...b.properties,
      }),
  );
  console.table(
    ibge.map((a) => ({
      name: a.nome,
      pop: +a.populacao,
      area: +a.area,
      dens: +a.densidade,
      idh: +a.idh,
    })),
  );
  return sourceData;
}

async function initMicrorregioesDoCearaLayer() {
  const mergeProps = (pList) => {
    const pop = pList.reduce((a, b) => a + 1 * b.populacao, 0);
    const ar = pList.reduce((a, b) => a + 1 * b.area, 0);
    return {
      microrregiao: pList[0].microrregiao,
      populacao: pop,
      area: ar,
      densidade: pop / ar,
      idh: pList.reduce((a, b) => a + b.idh * b.populacao, 0) / pop,
    };
  };
  const sourceData = await getMunicipiosSourceData();
  const microrregioesSourceData = turf.featureCollection(
    Object.values(
      sourceData.features.reduce((a, b) => {
        let x = b.properties.microrregiao;
        if (!a[x]) a[x] = [];
        a[x].push(b);
        return a;
      }, {}),
    ).map((a) => ({
      ...turf.union(turf.featureCollection(a)),
      properties: mergeProps(a.map((b) => b.properties)),
    })),
  );

  console.table(microrregioesSourceData.features.map((a) => a.properties));

  initAreaLayer({
    sourceData: microrregioesSourceData,
    layerId: "microrregioes",
    color: colorByProp(sourceData, "microrregiao"),
    zoom: 3,
    onclick: (e) => addPopup(e.lngLat, e.features[0].properties),
  });
}

async function initAreaLayer({
  layerId,
  sourceData,
  color,
  zoom,
  onclick,
  center,
}) {
  const sourceId = layerId + "_source";
  const borderId = layerId + "_border";
  const filter = zoom ? [">=", ["zoom"], zoom] : ["all"];
  let hoveredPolygonId = null;

  mapLoaded.onReady(async () => {
    if (center) {
      map.setZoom(center[0]);
      map.setCenter([center[1], center[2]]);
    }

    map.addSource(sourceId, {
      type: "geojson",
      generateId: true,
      data: sourceData,
    });

    map.addLayer(
      {
        id: layerId,
        type: "fill",
        source: sourceId,
        filter,
        layout: {},
        paint: {
          "fill-color": color,
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            0.45,
            0.15,
          ],
        },
      },
      map.getStyle().layers.find((a) => a["source-layer"] === "place_label").id,
    );

    map.addLayer(
      {
        id: borderId,
        type: "line",
        source: sourceId,
        filter,
        layout: {},
        paint: {
          "line-color": color,
          "line-offset": 0.5,
          "line-width": 1,
        },
      },
      layerId,
    );

    const setHover = (id, hover) =>
      map.setFeatureState({ source: sourceId, id }, { hover });

    map.on("mousemove", layerId, (e) => {
      if (e.features.length > 0) {
        if (hoveredPolygonId !== null) setHover(hoveredPolygonId, false);
        hoveredPolygonId = e.features[0].id;
        setHover(hoveredPolygonId, true);
      }
    });

    map.on("mouseleave", layerId, () => {
      if (hoveredPolygonId !== null) setHover(hoveredPolygonId, false);
      hoveredPolygonId = null;
    });

    window._hover = (prop, val) => {
      let x = map
        .querySourceFeatures(sourceId)
        .find((a) => a.properties[prop] == val);
      if (x) setHover(x.id, true);
    };

    map.on("click", layerId, (e) => {
      if (distanceActive.getValue()) return;
      console.log(e.features);
      onclick?.(e);
    });
  });
}

function initCitiesLayer() {
  mapLoaded.onReady(async () => {
    const cityList = await getCities();

    [[cityList, "points"]].forEach(([cities, layerId]) => {
      map.addSource(layerId, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: cities.map((city) => ({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [city.longitude, city.latitude],
            },
            properties: city,
          })),
        },
      });

      map.addLayer({
        id: layerId,
        type: "circle",
        source: layerId,
        filter: ["all", [">=", ["zoom"], ["get", "zoom"]], ["<", ["zoom"], 14]],
        paint: {
          "circle-stroke-width": 1,
          "circle-stroke-color": [
            "case",
            ["get", "is_capital"],
            "#000",
            "#fff",
          ],
          "circle-color": getCitiesColors().colors,
          "circle-translate": ["step", ["zoom"], [0, 0], 8, [0, 12]],
        },
      });

      map.on("click", layerId, (e) => {
        if (distanceActive.getValue()) return;
        addPopup(e.lngLat, formatCityProps(e.features[0].properties));
      });

      map.on("mouseenter", layerId, () => {
        if (distanceActive.getValue()) return;
        map.getCanvas().style.cursor = cursor.action;
      });

      map.on("mouseleave", layerId, () => {
        if (distanceActive.getValue()) return;
        map.getCanvas().style.cursor = cursor.idle;
      });
    });
  });
}

function formatCityProps(props) {
  const content = [
    `name: ${props.name}`,
    `country_code: ${props.country}`,
    `place: ${props.place || props.country_name}`,
    `is_capital: ${props.is_capital}`,
    `population: ${simplifyNumber(props.population)}`,
    `coords: (${props.latitude}, ${props.longitude})`,
  ];
  return content.join("\n");
}

function simplifyNumber(x) {
  let units = ["", "K", "M", "B", "T", "Q"];
  for (let i = 1; i < units.length; i++) {
    if (1000 ** i <= x) continue;
    return +(x / 1000 ** (i - 1)).toFixed(1) + units[i - 1];
  }
  return String(x);
}

function initPlaceHandlers() {
  map.on("style.load", () =>
    map
      .getStyle()
      .layers.map((a) => a.id)
      .filter((a) =>
        ["country-", "state-", "place-", "poi-"].some((b) => a.startsWith(b)),
      )
      .forEach((id) =>
        map.on("click", id, (e) => {
          const x = e.features[0];
          console.log(x);
        }),
      ),
  );
}

function initApp() {
  document.head.appendChild(
    elem("link", {
      rel: "stylesheet",
      href: "https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.css",
    }),
  );

  style("body", { margin: 0, padding: 0 });
  style("#map", { position: "absolute", top: 0, bottom: 0, width: "100%" });
  style("#distance", {
    position: "absolute",
    top: "10px",
    left: "10px",
    zIndex: 1,
  });
  style("#distance > *", {
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    color: "#fff",
    fontSize: "11px",
    lineHeight: "18px",
    display: "block",
    margin: "0",
    padding: "5px 10px",
    borderRadius: "3px",
  });
  style(".active", { background: "#fcd !important" });

  document.body.appendChild(elem("div", { id: "map" }));
  document.body.appendChild(elem("div", { id: "distance" }));

  mapboxgl[atob("IGFjY2Vzc1Rva2Vu").trim()] = atob(
    "IHBrLmV5SjFJam9pYVc1bmJHOXllVzl1SWl3aVlTSTZJbU50TW1WeFpUQXpaREF3ZVRReWFYQjRiMnQwY3pKcGJtUWlmUS5peW5FTVN6V2x2bFBWbU5EdDdKdU5R",
  ).trim();

  addEventListener("hashchange", () => {
    setTimeout(() => {
      // location.reload();
      loadResources();
    }, 500);
  });
}

function getProperty(obj, path) {
  if (!obj) return undefined;
  const [head, ...rest] = path.split(".");
  return !rest.length ? obj[head] : getProperty(obj[head], rest.join("."));
}
function pick(o, p) {
  return p.reduce((a, b) => ((a[b] = getProperty(o, b)), a), {});
}

function Subject(val) {
  if (!new.target) throw new Error();
  let value = val;
  let handlers = [];
  this.getValue = () => value;
  this.setValue = (x) => {
    if (x === value) return;
    value = x;
    for (let fn of handlers) fn(value);
  };
  this.onChange = (fn) => handlers.push(fn);
  this.offChange = (fn) => (handlers = handlers.filter((x) => x !== fn));
}

function Ready() {
  if (!new.target) throw new Error();
  const ready = new Subject(false);
  this.setReady = () => ready.setValue(true);
  this.onReady = (fn) => {
    if (ready.getValue()) return fn();
    ready.onChange(() => fn());
  };
}

function addPopup(lngLat, content) {
  new mapboxgl.Popup({ maxWidth: "none" })
    .setLngLat(lngLat)
    .setHTML(
      `<pre>${typeof content === "object" ? JSON.stringify(content, null, 2) : content}</pre>`,
    )
    .addTo(map);
}

function getHashParams() {
  const x = Object.fromEntries(
    new URLSearchParams(location.hash.substring(1))
      .entries()
      .map(([a, b]) => [
        a,
        b && (!isNaN(b) || ["false", "true", "null"].includes(b))
          ? JSON.parse(b)
          : b,
      ]),
  );
  return {
    mode: "cities",
    refresh: false,
    map: "default",
    print: false,
    ...x,
  };
}

function ButtonControl(id, content, onclick) {
  if (!new.target) throw new Error();
  this.onAdd = function (map) {
    this._map = map;
    this._container = elem(
      "div",
      {
        id,
        className: "mapboxgl-ctrl mapboxgl-ctrl-group",
        style: { background: "white" },
      },
      [
        elem(
          "button",
          {
            style: { width: 29, height: 29 },
            onclick,
          },
          content,
        ),
      ],
    );
    return this._container;
  };
  this.onRemove = function () {
    this._container.parentNode.removeChild(this._container);
    this._map = undefined;
  };
}

function colorByProp(sourceData, prop) {
  const cases = [
    ...new Set(
      sourceData.features.map((a) => a.properties).map((a) => a[prop]),
    ),
  ];
  const distinctColors = cases.map(
    (_, i) =>
      `hsl(${Math.floor((i / cases.length) * 360)}, 50%, ${i & 1 ? 50 : 33}%)`,
  );
  return [
    "case",
    ...cases
      .map((a, i) => [["==", ["get", prop], a], distinctColors[i]])
      .flat(),
    "#000",
  ];
}

function brNumber(s) {
  if (typeof s !== "string" || !s) return null;
  const isPercentage = s[s.length - 1] === "%";
  if (isPercentage) s = s.substring(0, s.length - 1);
  const x = s.replace(/\./g, "").replace(",", ".");
  return x / (isPercentage ? 100 : 1);
}

function downloadMap() {
  const dataURL = document.querySelector("#map canvas").toDataURL("image/jpeg");
  let link = document.createElement("a");
  link.href = dataURL;
  link.download =
    "map" + new Date().toISOString().replace(/[-T:]|(\..+$)/g, "") + ".jpeg";
  link.click();
}

var lastMode;
function initMap(mapStyle) {
  const { mode, print, map: mapMode } = getHashParams();

  let [zoom, ...center] = {
    bairros: [11, -38.52456247798946, -3.7902937131739804],
    municipios: [6, -39.31728004106648, -5.2982557237647825],
    microrregiao: [6, -39.31728004106648, -5.2982557237647825],
  }[mode] || [1, 30, 15];

  if (map) {
    if (mode === lastMode) {
      zoom = map.getZoom();
      center = map.getCenter();
    } else lastMode = mode;
    map.remove();
  }

  map = new mapboxgl.Map({
    container: "map",
    style:
      mapStyle ||
      (mode === "satellite"
        ? "mapbox://styles/mapbox/satellite-v9"
        : mapMode === "satellite"
          ? "mapbox://styles/mapbox/satellite-streets-v12"
          : "mapbox://styles/mapbox/streets-v9"),
    projection: "globe", // Display the map as a globe, since satellite-v9 defaults to Mercator
    zoom,
    center,
    preserveDrawingBuffer: Boolean(print),
  });

  map.addControl(new mapboxgl.NavigationControl());
  map.addControl(new mapboxgl.ScaleControl());
  map.addControl(
    new ButtonControl("distancecontrol", "+", () =>
      distanceActive.setValue(!distanceActive.getValue()),
    ),
  );
  // map.addControl(
  //   new ButtonControl("mapstyle", "s", () =>
  //     loadResources(prompt("map style:")),
  //   ),
  // );
  if (print)
    map.addControl(new ButtonControl("downloadmap", "v", () => downloadMap()));

  distanceActive.onChange((val) => {
    getElem("distancecontrol").classList.toggle("active");
  });

  map.on("style.load", () => {
    map.setFog({}); // Set the default atmosphere style
  });

  map.on("load", () => {
    mapLoaded.setReady();
  });

  // The following values can be changed to control rotation speed:

  // At low zooms, complete a revolution every two minutes.
  const secondsPerRevolution = 240;
  // Above zoom level 5, do not rotate.
  const maxSpinZoom = 5;
  // Rotate at intermediate speeds between zoom levels 3 and 5.
  const slowSpinZoom = 3;

  let userInteracting = false;
  const spinEnabled = true;

  function spinGlobe() {
    const zoom = map.getZoom();
    if (spinEnabled && !userInteracting && zoom < maxSpinZoom) {
      let distancePerSecond = 360 / secondsPerRevolution;
      if (zoom > slowSpinZoom) {
        // Slow spinning at higher zooms
        const zoomDif = (maxSpinZoom - zoom) / (maxSpinZoom - slowSpinZoom);
        distancePerSecond *= zoomDif;
      }
      const center = map.getCenter();
      center.lng -= distancePerSecond;
      // Smoothly animate the map over one second.
      // When this animation is complete, it calls a 'moveend' event.
      map.easeTo({ center, duration: 1000, easing: (n) => n });
    }
  }

  // // Pause spinning on interaction
  // map.on("mousedown", () => {
  //   userInteracting = true;
  // });
  // map.on("dragstart", () => {
  //   userInteracting = true;
  // });

  // // When animation is complete, start spinning if there is no ongoing interaction
  // map.on("moveend", () => {
  //   spinGlobe();
  // });

  // spinGlobe();
  window._map = map;
}

function initDistanceMeasure() {
  const distanceContainer = document.getElementById("distance");

  // GeoJSON object to hold our measurement features
  const geojson = {
    type: "FeatureCollection",
    features: [],
  };

  // Used to draw a line between points
  const linestring = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [],
    },
  };

  map.on("load", () => {
    map.addSource("geojson", {
      type: "geojson",
      data: geojson,
    });

    // Add styles to the map
    map.addLayer({
      id: "measure-points",
      type: "circle",
      source: "geojson",
      paint: {
        "circle-radius": 5,
        "circle-color": "#a00",
      },
      filter: ["in", "$type", "Point"],
    });
    map.addLayer({
      id: "measure-lines",
      type: "line",
      source: "geojson",
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#a00",
        "line-width": 2.5,
      },
      filter: ["in", "$type", "LineString"],
    });

    document.body.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      geojson.features = [];
      map.getSource("geojson").setData(geojson);
      distanceContainer.innerHTML = "";
    });

    distanceActive.onChange((isActive) => {
      if (!isActive) {
        cursor.idle = "";
      } else {
        cursor.idle = "crosshair";
      }
      map.getCanvas().style.cursor = cursor.idle;
    });

    map.on("click", (e) => {
      if (!distanceActive.getValue()) return;
      const features = map.queryRenderedFeatures(e.point, {
        layers: ["measure-points"],
      });

      // Remove the linestring from the group
      // so we can redraw it based on the points collection.
      if (geojson.features.length > 1) geojson.features.pop();

      // Clear the distance container to populate it with a new value.
      distanceContainer.innerHTML = "";

      // If a feature was clicked, remove it from the map.
      if (features.length) {
        const id = features[0].properties.id;
        geojson.features = geojson.features.filter(
          (point) => point.properties.id !== id,
        );
      } else {
        const point = {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [e.lngLat.lng, e.lngLat.lat],
          },
          properties: {
            id: String(new Date().getTime()),
          },
        };

        geojson.features.push(point);
      }

      if (geojson.features.length > 1) {
        linestring.geometry.coordinates = geojson.features.map(
          (point) => point.geometry.coordinates,
        );

        geojson.features.push(linestring);

        // Populate the distanceContainer with total distance
        const value = document.createElement("pre");
        const distance = turf.length(linestring);
        value.textContent = `Total distance: ${distance.toLocaleString()}km`;
        distanceContainer.appendChild(value);

        if (linestring.geometry.coordinates.length > 2) {
          const area = turf.area(turf.lineToPolygon(linestring));
          const pre = document.createElement("pre");
          pre.textContent = `Total area: ${(area / 1e6).toLocaleString()}km²`;
          distanceContainer.appendChild(pre);
        }
      }

      map.getSource("geojson").setData(geojson);
    });
  });

  map.on("mouseenter", "measure-points", () => {
    if (!distanceActive.getValue()) return;
    map.getCanvas().style.cursor = cursor.action;
  });
  map.on("mouseleave", "measure-points", () => {
    if (!distanceActive.getValue()) return;
    map.getCanvas().style.cursor = cursor.idle;
  });
}

async function getNotepadeData(id) {
  let json = !getHashParams().refresh && localStorage.getItem(id);
  if (!json) {
    json = await fetch("https://nopedat.netlify.app/api/?id=" + id).then((a) =>
      a.text(),
    );
    localStorage.setItem(id, json);
  }
  return JSON.parse(json);
}

function getCitiesColors() {
  const stops = [5e4, 1.5e5, 4e5, 9e5, 2e6, 7e6, 1.7e7];
  const colors = [
    [30, 50, 50],
    [60, 50, 50],
    [90, 50, 50],
    [120, 50, 35],
    [160, 50, 35],
    [210, 50, 50],
    [240, 50, 50],
    [280, 50, 50],
  ].map(([h, s, l]) => `hsl(${h},${s}%,${l}%)`);
  return {
    stops,
    colors: [
      "step",
      ["get", "population"],
      ...colors.map((a, i) => [a, ...stops.slice(i, i + 1)]).flat(),
    ],
  };
}

async function getCities() {
  const megaCityPop = getCitiesColors().stops.slice(-1)[0];
  const cities = citiesJson
    .map(({ mapbox, ninja, wiki, ...a }) => ({
      ...mapbox,
      ...ninja,
      ...wiki,
      ...a,
    }))
    .filter((a) => !!a.population)
    .sort((a, b) => {
      return (
        (a.capital ?? 10) - (b.capital ?? 10) ||
        a.scalerank - b.scalerank ||
        b.population - a.population
      );
    })
    .map((a, i) => {
      if (a.capital === 2 && a.scalerank <= 1) a.zoom = 0;
      else if (
        (a.capital === 2 && a.scalerank <= 2) ||
        a.population >= megaCityPop
      ) {
        a.zoom = 1;
      } else if ((a.capital === 2 && a.scalerank <= 3) || a.scalerank <= 1) {
        a.zoom = 2;
      } else if (
        (a.capital === 2 && a.scalerank < 7) ||
        a.layer === "place-city-lg"
      ) {
        a.zoom = 3;
      } else if (a.capital === 2 || a.layer === "place-city-md") a.zoom = 4;
      else a.zoom = 5;
      return a;
    })
    .reverse()
    .map((a) => ({
      ...a,
      name: a.name,
      latitude: a.lat,
      longitude: a.lon,
      is_capital: a.capital === 2,
    }));
  console.log(cities);
  return cities;
}
