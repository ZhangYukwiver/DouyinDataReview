import { Children, isValidElement } from "react";
import { expect, it, vi } from "vitest";
import { CommentImageThumbnails } from "./CommentImagePreview";

vi.mock("lucide-react-native", () => ({ X: () => null }));

it("点击多图评论的第二张缩略图时，预览所选图片", () => {
  const images = ["https://example.invalid/first.jpg", "https://example.invalid/second.jpg"];
  const onPreview = vi.fn();
  const thumbnails = CommentImageThumbnails({ images, onPreview });
  const buttons = Children.toArray(thumbnails?.props.children);
  const second = buttons.find((button) => isValidElement<{ "aria-label": string }>(button)
    && button.props["aria-label"] === "放大第 2 张评论图片");

  if (!isValidElement<{ onClick: () => void }>(second)) throw new Error("找不到第二张评论图片的放大按钮");
  second.props.onClick();
  expect(onPreview.mock.calls).toEqual([[images[1]]]);
});
