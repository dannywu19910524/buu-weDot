// Conservative structural validation for 8-bit Huffman baseline/progressive
// JPEG. This is not a pixel/entropy decoder. Inbound compatibility remains in
// media.mjs; outbound additionally requires complete tables and legal scans.
export function validateJPEG(b){
 const fail=()=>{throw new Error('outbound_image_rejected');};
 if(b.length<4||b[0]!==255||b[1]!==216)fail();
 const quant=new Set(),huffman=new Set(),components=new Map(),seenDC=new Set(),approximation=new Map();
 let at=2,frame=null,scans=0,restart=0;
 while(at<b.length){
  if(b[at++]!==255)fail();while(b[at]===255)at++;const marker=b[at++];
  if(marker===217){if(!frame||!scans||seenDC.size!==components.size||at!==b.length)fail();return;}
  if(marker===0||marker===216||marker===1||marker>=208&&marker<=215||at+2>b.length)fail();
  const length=b.readUInt16BE(at);if(length<2||at+length>b.length)fail();const p=b.subarray(at+2,at+length);at+=length;
  if(marker===219){
   let pos=0;if(!p.length)fail();
   while(pos<p.length){const spec=p[pos++],precision=spec>>4,id=spec&15;if(precision>1||id>3)fail();const n=64*(precision+1);if(pos+n>p.length)fail();for(let i=0;i<64;i++)if(precision?p.readUInt16BE(pos+i*2)===0:p[pos+i]===0)fail();pos+=n;quant.add(id);}
  }else if(marker===196){
   let pos=0;if(!p.length)fail();
   while(pos<p.length){const spec=p[pos++],kind=spec>>4,id=spec&15;if(kind>1||id>3||pos+16>p.length)fail();let total=0,space=1;
    for(let i=0;i<16;i++){const n=p[pos++];total+=n;space=space*2-n;if(space<0)fail();}
    if(!total||total>256||space===0||pos+total>p.length)fail();const values=new Set();
    for(let i=0;i<total;i++){const v=p[pos++];if(values.has(v)||(!kind&&v>11)||(kind&&((v&15)>10||((v&15)===0&&v!==0&&v!==240))))fail();values.add(v);}
    huffman.add(kind+':'+id);
   }
  }else if(marker===192||marker===194){
   if(frame||p.length<6||p[0]!==8)fail();const count=p[5],height=p.readUInt16BE(1),width=p.readUInt16BE(3);
   if(![1,3,4].includes(count)||p.length!==6+3*count||!width||!height||width>8192||height>8192||width*height>8*1024*1024)fail();
   let sampling=0;for(let i=0;i<count;i++){const id=p[6+3*i],hv=p[7+3*i],q=p[8+3*i],h=hv>>4,v=hv&15;if(components.has(id)||!h||h>4||!v||v>4||q>3)fail();components.set(id,q);approximation.set(id,Array(64).fill(null));sampling+=h*v;}
   if(sampling>10)fail();frame=marker;
  }else if(marker===221){if(p.length!==2)fail();restart=p.readUInt16BE(0);
  }else if(marker===218){
   if(!frame||p.length<6)fail();const count=p[0];if(!count||count>components.size||p.length!==1+2*count+3)fail();
   const ss=p[1+2*count],se=p[2+2*count],ah=p[3+2*count]>>4,al=p[3+2*count]&15;
   if(frame===192?(ss!==0||se!==63||ah!==0||al!==0):(ss>63||se<ss||se>63||(ss===0&&se!==0)||(ss!==0&&count!==1)||ah>13||al>13||(ah!==0&&ah!==al+1)))fail();
   const selected=new Set();for(let i=0;i<count;i++){const id=p[1+2*i],tables=p[2+2*i],dc=tables>>4,ac=tables&15;
    if(selected.has(id)||!components.has(id)||!quant.has(components.get(id))||dc>3||ac>3)fail();selected.add(id);
    if(frame===192){if(!huffman.has('0:'+dc)||!huffman.has('1:'+ac)||seenDC.has(id))fail();seenDC.add(id);}
    else if(ss===0){if(ac!==0||(ah===0&&!huffman.has('0:'+dc))||(ah!==0&&!seenDC.has(id)))fail();if(ah===0)seenDC.add(id);}
    else if(dc!==0||!seenDC.has(id)||!huffman.has('1:'+ac))fail();
    // Every progressive coefficient must be introduced exactly once; each
    // refinement continues its immediately previous low-bit approximation.
    // A seen-DC flag alone cannot validate AC initialization or refinements.
    if(frame===194){const states=approximation.get(id);for(let coefficient=ss;coefficient<=se;coefficient++){if(ah===0?states[coefficient]!==null:states[coefficient]!==ah)fail();states[coefficient]=al;}}
   }
   let entropy=0,expectedRestart=0;
   while(at<b.length){if(b[at]!==255){at++;entropy++;continue;}if(b[at+1]===0){at+=2;entropy++;continue;}
    if(b[at+1]>=208&&b[at+1]<=215){if(!restart||b[at+1]!==208+expectedRestart)fail();expectedRestart=(expectedRestart+1)%8;at+=2;continue;}break;
   }
   if(!entropy)fail();scans++;
  }else if(!(marker>=224&&marker<=239)&&marker!==254)fail();
 }
 fail();
}
