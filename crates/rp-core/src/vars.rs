//! {{var}} 变量替换：语义与 shared 的 substituteVariables 一致
//! （未命中的占位符保持原样，含空格或嵌套花括号的写法不视为变量）。
use std::collections::HashMap;

pub fn substitute(template: &str, vars: &HashMap<String, String>) -> String {
    if !template.contains("{{") {
        return template.to_string();
    }
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            // 没有闭合的花括号，原样输出剩余内容
            out.push_str("{{");
            out.push_str(after);
            return out;
        };
        let raw = &after[..end];
        let name = raw.trim();
        let is_var =
            !name.is_empty() && !name.contains(|c: char| c.is_whitespace() || c == '{' || c == '}');
        match vars.get(name) {
            Some(value) if is_var => {
                out.push_str(value);
                rest = &after[end + 2..];
            }
            _ => {
                // 与 shared 的正则一致：占位符不合法（含空白 / 花括号）或未命中时，
                // 只越过开头的 "{{"，让后面的内容仍有机会被当作变量重新匹配
                // （例如 {{{{a}}}} 的内层 {{a}} 会被替换）
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn substitute_opt(value: &Option<String>, vars: &HashMap<String, String>) -> Option<String> {
    value.as_ref().map(|v| substitute(v, vars))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> HashMap<String, String> {
        HashMap::from([
            ("host".to_string(), "example.com".to_string()),
            ("token".to_string(), "abc".to_string()),
        ])
    }

    #[test]
    fn replaces_known_variables() {
        assert_eq!(
            substitute("https://{{host}}/api?t={{token}}", &vars()),
            "https://example.com/api?t=abc"
        );
    }

    #[test]
    fn keeps_unknown_placeholders() {
        assert_eq!(substitute("{{missing}}", &vars()), "{{missing}}");
    }

    #[test]
    fn keeps_invalid_shapes() {
        assert_eq!(substitute("{{ with space }}", &vars()), "{{ with space }}");
        assert_eq!(substitute("{{nested{{x}}}}", &vars()), "{{nested{{x}}}}");
    }

    #[test]
    fn handles_unclosed_braces() {
        assert_eq!(substitute("prefix {{host", &vars()), "prefix {{host");
    }

    #[test]
    fn nested_braces_match_inner_variable_like_shared_regex() {
        // shared 的 VAR_PATTERN 会在 {{{{a}}}} 中匹配内层 {{a}}
        let vars = HashMap::from([("a".to_string(), "1".to_string())]);
        assert_eq!(substitute("{{{{a}}}}", &vars), "{{1}}");
    }

    #[test]
    fn replaces_multiple_adjacent_and_empty_values() {
        let vars = HashMap::from([
            ("a".to_string(), "1".to_string()),
            ("b".to_string(), "2".to_string()),
            // 空字符串也是合法值，应被替换掉而不是保留占位符
            ("empty".to_string(), String::new()),
        ]);
        assert_eq!(substitute("{{a}}-{{b}}", &vars), "1-2");
        assert_eq!(substitute("{{a}}{{b}}", &vars), "12");
        assert_eq!(substitute("x{{empty}}y", &vars), "xy");
        // 命中与未命中混合：未命中保持原样
        assert_eq!(substitute("{{a}}{{nope}}{{b}}", &vars), "1{{nope}}2");
    }
}
