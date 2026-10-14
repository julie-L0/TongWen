import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { EditorContent, useEditor, NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import UniqueID from '@tiptap/extension-unique-id';
import { Sparkles, Check } from 'lucide-react';

function ParagraphView({node,extension}:any){
  return <NodeViewWrapper className="paragraph-section" data-block-id={node.attrs.id}>
    <div className="section-label" contentEditable={false}>{node.attrs.title}</div>
    <div className="paragraph-line"><NodeViewContent as="div" className="paragraph-text"/>
      {extension.options.reviewMode&&<button className="check-paragraph" contentEditable={false} onMouseDown={e=>e.preventDefault()} onClick={()=>extension.options.onCheck(node.attrs.id)} title="检查这段信息" aria-label={`检查段落 ${node.attrs.id}`}><Sparkles size={15}/><span>检查</span></button>}
    </div>
  </NodeViewWrapper>;
}
const WorkParagraph=Paragraph.extend({
  addOptions(){return {...this.parent?.(),onCheck:()=>{},reviewMode:false};},
  addAttributes(){return {...this.parent?.(),title:{default:''}};},
  addKeyboardShortcuts(){return {Enter:()=>this.editor.commands.setHardBreak()};},
  addNodeView(){return ReactNodeViewRenderer(ParagraphView);},
});
export type EditorHandle={demoChange:()=>void};
export default forwardRef<EditorHandle,{blocks:any[],onChange:(blocks:any[])=>void,onCheck:(id:string)=>void,reviewMode?:boolean,editable?:boolean,title?:string}>(function SourceEditor({blocks,onChange,onCheck,reviewMode=false,editable=true,title='文档'},ref){
  const callbacks=useRef({onChange,onCheck});callbacks.current={onChange,onCheck};
  const content=blocks.map((f,i)=>({type:'paragraph',attrs:{id:f.id,title:`${String(i+1).padStart(2,'0')}  ${f.title}`},content:[{type:'text',text:f.text}]}));
  const editor=useEditor({extensions:[StarterKit.configure({paragraph:false,heading:false,bulletList:false,orderedList:false,blockquote:false,codeBlock:false}),WorkParagraph.configure({onCheck:(id:string)=>callbacks.current.onCheck(id),reviewMode} as any),UniqueID.configure({types:['paragraph']})],editable,content:{type:'doc',content},onUpdate:({editor})=>{const next:any[]=[];editor.state.doc.descendants(node=>{if(node.type.name==='paragraph')next.push({id:node.attrs.id,text:node.textContent});});callbacks.current.onChange(next);},editorProps:{attributes:{class:'document-editor','aria-label':`${title} 文本编辑器`}}},[reviewMode]);
  React.useEffect(()=>{editor?.setEditable(editable,false);},[editor,editable]);
  React.useEffect(()=>{if(!editor)return;const current:any[]=[];editor.state.doc.descendants(n=>{if(n.type.name==='paragraph')current.push({id:n.attrs.id,text:n.textContent});});if(JSON.stringify(current)!==JSON.stringify(blocks.map(f=>({id:f.id,text:f.text}))))editor.commands.setContent({type:'doc',content},{emitUpdate:false});},[editor,blocks]);
  useImperativeHandle(ref,()=>({demoChange(){if(!editor)return;const json=editor.getJSON();const node=json.content?.find(n=>n.attrs?.id==='p-valid');if(node){node.content=[{type:'text',text:'高级会员开通后，智能识别功能可在 40 天内使用。',marks:[]}];editor.commands.setContent(json);}}}),[editor]);
  return <EditorContent editor={editor}/>;
});
