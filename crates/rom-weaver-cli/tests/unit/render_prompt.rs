use super::invalid_selection_message;

#[test]
fn escape_sequences_get_the_key_hint_wherever_they_appear() {
    for input in ["\u{1b}[B", "2\u{1b}[D", "\u{1b}OP"] {
        let message = invalid_selection_message(input, "Enter 1..2 or `q`.");
        assert_eq!(
            message, "arrow and function keys do not work here. Enter 1..2 or `q`.",
            "{input:?}"
        );
    }
}

#[test]
fn ordinary_invalid_input_is_echoed() {
    assert_eq!(
        invalid_selection_message("abc", "Enter 1..2 or `q`."),
        "invalid selection `abc`. Enter 1..2 or `q`."
    );
}
