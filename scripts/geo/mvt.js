/* ── minimal Mapbox Vector Tile (MVT / pbf) decoder — zero dependencies ──
   Decodes a .pbf vector tile ArrayBuffer into
   { layers: { name: { extent, features:[{ id, type, props, rings }] } } }
   where rings is an array of flat [x0,y0,x1,y1,...] arrays in tile-local
   integer coordinates (0..extent). type: 1=point 2=line 3=polygon. */

const td=new TextDecoder();

export function decodeMVT(ab){
  const u8=new Uint8Array(ab);
  let p=0;

  const varint=()=>{
    let lo=0, hi=0, shift=0, b;
    do{
      b=u8[p++];
      if(shift<28) lo|=(b&127)<<shift;
      else hi+=(b&127)*Math.pow(2,shift-28);
      shift+=7;
    }while(b&128);
    return (lo>>>0)+hi*4294967296;
  };
  const skip=w=>{
    if(w===0) varint();
    else if(w===1) p+=8;
    else if(w===2) p+=varint();
    else if(w===5) p+=4;
  };
  const str=len=>{const s=td.decode(u8.subarray(p,p+len));p+=len;return s;};

  const readValue=len=>{
    const end=p+len; let v=null;
    while(p<end){
      const t=varint(), f=t>>3, w=t&7;
      if(f===1&&w===2) v=str(varint());
      else if(f===2&&w===5){v=new DataView(u8.buffer,u8.byteOffset+p,4).getFloat32(0,true);p+=4;}
      else if(f===3&&w===1){v=new DataView(u8.buffer,u8.byteOffset+p,8).getFloat64(0,true);p+=8;}
      else if(f===4&&w===0) v=varint();
      else if(f===5&&w===0) v=varint();
      else if(f===6&&w===0){const z=varint();v=(z%2)?-(z+1)/2:z/2;}
      else if(f===7&&w===0) v=!!varint();
      else skip(w);
    }
    p=end;
    return v;
  };

  const readFeature=(len,keys,values)=>{
    const end=p+len;
    const f={id:0,type:0,props:{},rings:[]};
    let gs=-1, ge=-1;
    while(p<end){
      const t=varint(), fl=t>>3, w=t&7;
      if(fl===1&&w===0) f.id=varint();
      else if(fl===2&&w===2){
        const l=varint(), e2=p+l;
        while(p<e2){const k=varint(),v=varint();f.props[keys[k]]=values[v];}
      }
      else if(fl===3&&w===0) f.type=varint();
      else if(fl===4&&w===2){const l=varint();gs=p;ge=p+l;p=ge;}
      else skip(w);
    }
    if(gs>=0){
      const save=p; p=gs;
      let x=0,y=0,cur=null;
      while(p<ge){
        const cmd=varint(), op=cmd&7, cnt=cmd>>3;
        if(op===1){
          for(let i=0;i<cnt;i++){
            const zx=varint(), zy=varint();
            x+=(zx>>>1)^(-(zx&1)); y+=(zy>>>1)^(-(zy&1));
            cur=[x,y]; f.rings.push(cur);
          }
        } else if(op===2){
          for(let i=0;i<cnt;i++){
            const zx=varint(), zy=varint();
            x+=(zx>>>1)^(-(zx&1)); y+=(zy>>>1)^(-(zy&1));
            cur.push(x,y);
          }
        } else if(op===7){
          /* ClosePath — closure is implicit in the ring */
        } else break;
      }
      p=save;
    }
    p=end;
    return f;
  };

  const readLayer=len=>{
    const end=p+len;
    const keys=[], values=[], spans=[];
    let name='', extent=4096;
    while(p<end){
      const t=varint(), f=t>>3, w=t&7;
      if(f===1&&w===2) name=str(varint());
      else if(f===2&&w===2){const l=varint();spans.push([p,l]);p+=l;}
      else if(f===3&&w===2) keys.push(str(varint()));
      else if(f===4&&w===2) values.push(readValue(varint()));
      else if(f===5&&w===0) extent=varint();
      else skip(w);
    }
    const features=[];
    for(const[s,l]of spans){p=s;features.push(readFeature(l,keys,values));}
    p=end;
    return {name,extent,features};
  };

  const layers={};
  while(p<u8.length){
    const t=varint(), f=t>>3, w=t&7;
    if(f===3&&w===2){const l=readLayer(varint());layers[l.name]=l;}
    else skip(w);
  }
  return {layers};
}

/* signed ring area in tile coords (y-down). Per the MVT spec, exterior
   polygon rings have POSITIVE area under the surveyor's formula. */
export function ringArea(r){
  let a=0;
  const n=r.length;
  for(let i=0;i<n;i+=2){
    const j=(i+2)%n;
    a+=r[i]*r[j+1]-r[j]*r[i+1];
  }
  return a/2;
}

/* ── OpenFreeMap tile URL resolution ──
   OpenFreeMap publishes its tiles under a VERSIONED path (e.g.
   /planet/20250101_001pt/{z}/{x}/{y}.pbf) announced in the TileJSON at
   /planet. Direct unversioned /planet/{z}/{x}/{y}.pbf requests 404 —
   which silently read as "empty tile" and broke water + buildings. The
   template is fetched once and shared by every tile consumer. */
let tjPromise=null;
export function tileTemplate(){
  if(!tjPromise){
    tjPromise=fetch('https://tiles.openfreemap.org/planet')
      .then(r=>{ if(!r.ok) throw 0; return r.json(); })
      .then(j=>(Array.isArray(j.tiles)&&j.tiles[0])||'https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf')
      .catch(()=>{
        tjPromise=null; /* allow a later retry instead of caching failure */
        return 'https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf';
      });
  }
  return tjPromise;
}
export function tileURL(tpl,z,x,y){
  return tpl.replace('{z}',z).replace('{x}',x).replace('{y}',y);
}
