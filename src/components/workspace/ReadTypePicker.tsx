import React from "react";
import { Pressable, Text, View, type StyleProp, type TextStyle } from "react-native";
import { PERSONAL_RECORD_TYPES, type PersonalRecordType } from "../../domain/personalRecords";

export const READ_TYPE_NAMES: Record<PersonalRecordType, string> = { watch_history: "观看历史", liked_videos: "喜欢", favorite_videos: "收藏" };

/** 增量 / 完整读取读哪几类：只读观看历史、只读喜欢……两个采集器页共用，字色跟各自页面走 */
export function ReadTypePicker({ types, onToggle, disabled, textStyle, activeStyle }: {
  types: readonly PersonalRecordType[];
  onToggle: (type: PersonalRecordType) => void;
  disabled: boolean;
  textStyle: StyleProp<TextStyle>;
  activeStyle: StyleProp<TextStyle>;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 4 }} testID="read-types">
      <Text style={textStyle}>读取</Text>
      {PERSONAL_RECORD_TYPES.map(({ id }) => {
        const on = types.includes(id);
        // 最后一类勾不掉，免得一类都不读
        const locked = on && types.length === 1;
        return (
          <Pressable key={id} accessibilityRole="checkbox" accessibilityLabel={`读取${READ_TYPE_NAMES[id]}`} accessibilityState={{ checked: on, disabled: disabled || locked }}
            aria-checked={on} disabled={disabled || locked} onPress={() => onToggle(id)} testID={`read-type-${id}`}>
            <Text style={[textStyle, on && activeStyle, disabled && { opacity: 0.5 }]}>{on ? "☑" : "☐"} {READ_TYPE_NAMES[id]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
