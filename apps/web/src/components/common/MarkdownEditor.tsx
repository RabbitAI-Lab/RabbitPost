import Cherry from "cherry-markdown";
import "cherry-markdown/dist/cherry-markdown.css";
import { useEffect, useRef } from "react";

interface Props {
  /** 初始 Markdown 内容（仅初始化时读取，编辑内容由 Cherry 内部维护） */
  initialValue: string;
  /** edit = 编辑模式（默认），preview = 预览模式 */
  mode: "edit" | "preview";
  onChange: (markdown: string) => void;
}

/** Cherry Markdown 编辑器通用封装（Collection Overview / 请求 Docs 共用） */
export default function MarkdownEditor({ initialValue, mode, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cherryRef = useRef<Cherry | null>(null);
  // afterChange 回调里引用最新 onChange，避免闭包过期
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValueRef = useRef(initialValue);
  const modeRef = useRef(mode);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const cherry = new Cherry({
      el,
      value: initialValueRef.current,
      editor: {
        defaultModel: modeRef.current === "preview" ? "previewOnly" : "editOnly",
        height: "100%",
      },
      toolbars: {
        toolbar: [
          "bold",
          "italic",
          "strikethrough",
          "|",
          "header",
          "list",
          "quote",
          "hr",
          "|",
          "link",
          "image",
          "code",
          "table",
        ],
        sidebar: [],
        bubble: false,
        float: false,
        toc: false,
      },
      callback: {
        afterChange: (text: string) => onChangeRef.current(text),
      },
    });
    cherryRef.current = cherry;
    return () => {
      cherryRef.current = null;
      cherry.destroy();
      // destroy 后清空容器，避免 StrictMode 双挂载残留 DOM
      el.replaceChildren();
    };
  }, []);

  // 编辑 / 预览模式切换
  useEffect(() => {
    modeRef.current = mode;
    cherryRef.current?.switchModel(
      mode === "preview" ? "previewOnly" : "editOnly",
    );
  }, [mode]);

  return (
    <div
      ref={containerRef}
      className="md-cherry"
      style={{ height: "100%", minHeight: 0 }}
    />
  );
}
