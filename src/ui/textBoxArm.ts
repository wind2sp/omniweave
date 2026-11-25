// 삽입 ▸ 글상자 in a document (Word 가로 글상자 그리기, 한글 글상자): the next press on the page makes a text box there —
// also over the body text, which the text tool otherwise types into (the caret, as Word's I-beam). Armed by the command,
// gone when the box is made or another tool is chosen. (QA 11-25 real use: the press went into the body text.)

import { useStore } from "../core/store";

let armed = false;

export const armTextBox = () => {
  armed = true;
};
export const textBoxArmed = () => armed;
export const disarmTextBox = () => {
  armed = false;
};

useStore.subscribe((s, prev) => {
  if (armed && s.tool !== prev.tool && s.tool !== "text") armed = false;
});
