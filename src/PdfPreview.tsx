import React, { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
export default function PdfPreview({locator,url='/assets/membership-guide.pdf'}:any){
 const ref=useRef<HTMLCanvasElement>(null),container=useRef<HTMLDivElement>(null);const [error,setError]=useState(''),[ready,setReady]=useState(false);
 useEffect(()=>{let gone=false;let render:any;const loading=pdfjs.getDocument(url);setReady(false);setError('');
  (async()=>{try{const pdf=await loading.promise;const page=await pdf.getPage(locator.page);if(gone)return;const base=page.getViewport({scale:1});const width=Math.min(container.current?.clientWidth||550,620);const scale=width/base.width;const view=page.getViewport({scale});const canvas=ref.current!;const ratio=window.devicePixelRatio||1;canvas.width=view.width*ratio;canvas.height=view.height*ratio;canvas.style.width=`${view.width}px`;canvas.style.height=`${view.height}px`;render=page.render({canvasContext:canvas.getContext('2d')!,canvas,viewport:view,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});await render.promise;if(!gone)setReady(true);}catch(e:any){if(!gone&&e.name!=='RenderingCancelledException')setError('PDF 页面加载失败，请重新打开详情。');}})();
  return ()=>{gone=true;render?.cancel();void loading.destroy();};
 },[locator.page,locator.assetId,url]);
 return <div ref={container} className="pdf-container">{error?<div className="inline-error">{error}</div>:<>{!ready&&<div className="pdf-loading">正在加载原始页面…</div>}<div className="pdf-page" style={{opacity:ready?1:0}}><canvas ref={ref}/>{ready&&locator.bbox&&<div className="evidence-highlight" style={{left:`${locator.bbox.x*100}%`,top:`${locator.bbox.y*100}%`,width:`${locator.bbox.width*100}%`,height:`${locator.bbox.height*100}%`}}/>}</div></>}</div>;
}
