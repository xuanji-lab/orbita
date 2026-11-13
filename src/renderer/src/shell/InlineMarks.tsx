import { inlineMarks } from "./inline-marks.ts";

/** 一行标题的行内 markdown：代码段等宽画，粗体记号剥掉（拆法见 inline-marks.ts） */
export function InlineMarks(props: { text: string }) {
  return (
    <>
      {inlineMarks(props.text).map((mark, index) =>
        mark.kind === "code" ? (
          <code key={index} className="inline-mark-code">
            {mark.text}
          </code>
        ) : (
          <span key={index}>{mark.text}</span>
        ),
      )}
    </>
  );
}
