/* "Podavo" map style: the same pastel look as the Podavo Clean map (qubexon-pl/tidy, react/src/components/MapView.tsx),
   drawn on OpenFreeMap "positron" vector tiles (no API key) through MapLibre GL inside the existing Leaflet maps.
   Differences from Podavo Clean, on purpose:
   - every label uses the plain Noto Sans (positron writes water and some place names in italics);
   - transport stays visible (rail lines and stations matter here), and labels are not hidden as much.
   MapLibre and its Leaflet bridge load only when a map first needs this style; if anything fails, the caller falls back
   to the raster tiles it used before. */
(function(root){
  'use strict';
  const STYLE_URL='https://tiles.openfreemap.org/styles/positron';
  const LIBS={
    css:'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
    js:'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    bridge:'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.22/leaflet-maplibre-gl.js',
  };
  // Podavo Clean palette (mint, aqua, butter, coral, navy pastels).
  const PASTEL={
    land:'#f1f6ee', landuse:'#f6f2e7', park:'#cdebd6', wood:'#bfe3cb', wetland:'#c9ebe5', grass:'#d7f0d9', sand:'#f8eed3',
    water:'#aee0e6', buildings:['#fbe3d6','#e9e3f6','#fdf1cc','#dcedf6','#f6e4ea'],
    road:'#ffffff', roadMajor:'#fde9b3', casing:'#e4ddd0', path:'#e6efe2', rail:'#9fb2c9', boundary:'#9fb2c9',
    label:'#1a2b4c', labelSoft:'#4a5c7a', halo:'#ffffff',
  };
  const FONT_REGULAR=['Noto Sans Regular'], FONT_BOLD=['Noto Sans Bold'];

  // Plain (non-italic) font for every label; bold stays bold so cities still stand out.
  function plainFont(font){
    const s=JSON.stringify(font||'');
    return /Bold/i.test(s)?FONT_BOLD:FONT_REGULAR;
  }

  function styleLayer(layer){
    const kind=layer['source-layer']||'', id=layer.id||'';
    const paint=(layer.paint ||= {});
    if(layer.type==='background') paint['background-color']=PASTEL.land;
    if(layer.type==='fill'){
      if(kind==='water'){ paint['fill-color']=PASTEL.water; paint['fill-opacity']=1; }
      if(kind==='building'){
        const [b0,b1,b2,b3,b4]=PASTEL.buildings;
        paint['fill-color']=['match',['%',['to-number',['id'],0],5],0,b0,1,b1,2,b2,3,b3,b4];
        paint['fill-outline-color']='rgba(26,43,76,0.08)'; paint['fill-opacity']=1;
      }
      if(kind==='park' || (kind==='landuse' && /park|garden|cemetery|recreation/.test(id))){ paint['fill-color']=PASTEL.park; paint['fill-opacity']=1; }
      else if(kind==='landuse') paint['fill-color']=PASTEL.landuse;
      if(kind==='landcover'){
        paint['fill-color']=['match',['coalesce',['get','subclass'],['get','class'],''],
          ['wood','forest'],PASTEL.wood, ['wetland','marsh','reedbed'],PASTEL.wetland,
          ['grass','meadow','scrub','heath','grassland'],PASTEL.grass, ['sand','bare_rock','rock'],PASTEL.sand, PASTEL.grass];
        paint['fill-opacity']=1;
      }
    }
    if(layer.type==='line'){
      if(kind==='waterway') paint['line-color']=PASTEL.water;
      if(kind==='boundary'){ paint['line-color']=PASTEL.boundary; paint['line-opacity']=0.5; }
      if(kind==='transportation'){
        if(/rail|transit/.test(id)){ paint['line-color']=PASTEL.rail; paint['line-opacity']=0.7; }
        else if(/ferry|pier/.test(id)) paint['line-opacity']=0.3;
        else if(/path|track|pedestrian/.test(id)) paint['line-color']=PASTEL.path;
        else if(/casing/.test(id)) paint['line-color']=PASTEL.casing;
        else {
          paint['line-color']=/motorway|trunk|primary|major/.test(id)?PASTEL.roadMajor:PASTEL.road;
          paint['line-opacity']=1; (layer.layout ||= {})['line-join']='round';
        }
      }
    }
    if(layer.type==='symbol' && layer.layout?.['text-field']){
      layer.layout['text-font']=plainFont(layer.layout['text-font']);
      const street=kind==='transportation_name';
      paint['text-color']=street||kind==='place'?PASTEL.label:PASTEL.labelSoft;
      paint['text-halo-color']=PASTEL.halo;
      paint['text-halo-width']=street?1.6:1.2;
      if(street) paint['text-halo-blur']=0.2;
      // shop / restaurant icons and labels are noise on a transport map
      if(kind==='poi' && !/rail|station|transit|airport|bus/.test(id)) layer.layout.visibility='none';
    }
    return layer;
  }

  let styleP=null, libsP=null;
  function loadScript(src){ return new Promise((res,rej)=>{ const el=document.createElement('script'); el.src=src; el.async=true; el.onload=res; el.onerror=()=>rej(new Error('Nie wczytano '+src)); document.head.appendChild(el); }); }
  function ensureLibs(){
    if(libsP) return libsP;
    if(!document.querySelector(`link[href="${LIBS.css}"]`)){ const l=document.createElement('link'); l.rel='stylesheet'; l.href=LIBS.css; document.head.appendChild(l); }
    libsP=(root.maplibregl?Promise.resolve():loadScript(LIBS.js))
      .then(()=>root.L?.maplibreGL?null:loadScript(LIBS.bridge))
      .then(()=>{ if(!root.L?.maplibreGL) throw new Error('Brak L.maplibreGL'); });
    libsP.catch(()=>{ libsP=null; });
    return libsP;
  }
  function podavoStyle(){
    if(styleP) return styleP;
    styleP=fetch(STYLE_URL).then(r=>{ if(!r.ok) throw new Error('Styl mapy: HTTP '+r.status); return r.json(); })
      .then(style=>{ style.layers=style.layers.map(styleLayer); return style; });
    styleP.catch(()=>{ styleP=null; });
    return styleP;
  }
  // A Leaflet layer with the Podavo style. Resolves once the libraries and the style are in; rejects on any failure.
  function podavoLayer(){
    return Promise.all([ensureLibs(), podavoStyle()]).then(([,style])=>root.L.maplibreGL({
      style, interactive:false,
      attribution:'<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }));
  }

  root.PODAVO_MAP={STYLE_URL, PASTEL, styleLayer, plainFont, podavoLayer};
})(typeof window!=='undefined'?window:globalThis);
