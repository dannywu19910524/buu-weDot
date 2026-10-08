// Runtime-generated 1x1 grayscale Huffman JPEG. DC=0 and EOB use one-bit
// codes, producing a neutral gray pixel. No photographs or opaque assets.
const segment=(marker,payload)=>{const head=Buffer.alloc(4);head[0]=255;head[1]=marker;head.writeUInt16BE(payload.length+2,2);return Buffer.concat([head,payload]);};
export function jpegFixture({progressive=false,omitQuant=false,omitHuffman=false,emptyScan=false}={}){
 const counts=Buffer.alloc(16);counts[0]=1;
 const dqt=segment(219,Buffer.concat([Buffer.from([0]),Buffer.alloc(64,1)]));
 const dht=segment(196,Buffer.concat([Buffer.from([0]),counts,Buffer.from([0,16]),counts,Buffer.from([0])]));
 const frame=segment(progressive?194:192,Buffer.from([8,0,1,0,1,1,1,17,0]));
 const scans=emptyScan?[segment(218,Buffer.alloc(0)),Buffer.from([0])]:progressive?[segment(218,Buffer.from([1,1,0,0,0,0])),Buffer.from([127]),segment(218,Buffer.from([1,1,0,1,63,0])),Buffer.from([127])]:[segment(218,Buffer.from([1,1,0,0,63,0])),Buffer.from([63])];
 return Buffer.concat([Buffer.from([255,216]),...(omitQuant?[]:[dqt]),...(omitHuffman?[]:[dht]),frame,...scans,Buffer.from([255,217])]);
}
