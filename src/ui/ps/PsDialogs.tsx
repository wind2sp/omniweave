// Mount point of the image mode's Photoshop dialogs (adjustment layer properties, image size, fill), into <body>.

import { createPortal } from "react-dom";
import { AdjustDialog } from "./AdjustDialog";
import { FillDialog } from "./FillDialog";
import { ImageSizeDialog } from "./imageSize";
import { SelectMaskDialog } from "./SelectMaskDialog";
import { LayerStyleDialog } from "./LayerStyle";
import { LiquifyDialog } from "./LiquifyDialog";

export function PsDialogs() {
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <AdjustDialog />
      <ImageSizeDialog />
      <FillDialog />
      <SelectMaskDialog />
      <LayerStyleDialog />
      <LiquifyDialog />
    </>,
    document.body,
  );
}
