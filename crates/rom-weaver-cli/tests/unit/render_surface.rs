use super::*;

#[test]
fn human_cells_escape_controls_without_changing_unicode() {
    assert_eq!(
        display_text("日本語\tgame\r\n\x1b[31m.bin"),
        "日本語\\tgame\\r\\n\\u{1b}[31m.bin"
    );
    assert_eq!(display_text("Pokémon (Europe).gb"), "Pokémon (Europe).gb");
}

#[test]
fn human_lines_escape_embedded_line_breaks_and_terminal_commands() {
    assert_eq!(
        display_text("first\nsecond\x1b[2J"),
        "first\\nsecond\\u{1b}[2J"
    );
}

#[test]
fn explicit_color_override_applies_to_both_streams() {
    for style in [HumanStyle::Simple, HumanStyle::Rich] {
        let disabled = Surface::new(style, Some(false));
        assert!(!disabled.color);
        assert!(!disabled.stderr_color);
        let enabled = Surface::new(style, Some(true));
        assert!(enabled.color);
        assert!(enabled.stderr_color);
    }
}
