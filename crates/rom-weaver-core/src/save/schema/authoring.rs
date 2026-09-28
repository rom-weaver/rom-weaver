use super::{
    MAX_COMPONENTS, MAX_GAMES, RawChoice, RawGame, bounded_text, invalid, invalid_owned,
    validate_field_id,
};
use crate::Result;
use serde::de::{Error as _, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fmt;

// Reuse MUST be charged before cloning. The source already has a 2 MiB limit.
const MAX_NORMALIZED_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn from_json(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice::<StrictValue>(bytes)
        .map(|value| value.0)
        .map_err(|error| invalid_owned(format!("invalid save schema JSON: {error}")))
}

struct StrictValue(Value);

impl<'de> serde::Deserialize<'de> for StrictValue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        d.deserialize_any(StrictVisitor)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = StrictValue;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON without duplicate object keys")
    }
    fn visit_bool<E>(self, v: bool) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(v)))
    }
    fn visit_i64<E>(self, v: i64) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(v.into())))
    }
    fn visit_u64<E>(self, v: u64) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(v.into())))
    }
    fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .map(StrictValue)
            .ok_or_else(|| E::custom("JSON numbers must be finite"))
    }
    fn visit_str<E>(self, v: &str) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::String(v.into())))
    }
    fn visit_string<E>(self, v: String) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::String(v)))
    }
    fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }
    fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }
    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(value) = seq.next_element::<StrictValue>()? {
            values.push(value.0);
        }
        Ok(StrictValue(Value::Array(values)))
    }
    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = Map::with_capacity(map.size_hint().unwrap_or(0));
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(A::Error::custom(format!("duplicate object key {key:?}")));
            }
            values.insert(key, map.next_value::<StrictValue>()?.0);
        }
        Ok(StrictValue(Value::Object(values)))
    }
}

pub(super) fn normalize(mut value: Value) -> Result<Value> {
    let mut budget = size(&value)?;
    let root = object(&mut value, "a save schema pack must be an object")?;
    let profiles = take_map(root, "profiles")?;
    let choices = take_map(root, "choices")?;
    validate_profiles(&profiles)?;
    validate_choices(&choices)?;
    visit_records(root, &choices, &mut budget)?;
    visit_games(root, &profiles, &choices, &mut budget)?;
    if size(&value)? > MAX_NORMALIZED_BYTES {
        return Err(limit());
    }
    Ok(value)
}

fn take_map(root: &mut Map<String, Value>, key: &str) -> Result<Map<String, Value>> {
    match root.remove(key) {
        None => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err(invalid(&format!("{key} must be an object"))),
    }
}

fn validate_profiles(profiles: &Map<String, Value>) -> Result<()> {
    if profiles.len() > MAX_COMPONENTS {
        return Err(invalid("profiles exceed 4096 entries"));
    }
    for name in profiles.keys() {
        validate_field_id(name)?;
    }
    Ok(())
}

fn validate_choices(choices: &Map<String, Value>) -> Result<()> {
    if choices.len() > MAX_COMPONENTS {
        return Err(invalid("choice sets exceed 4096 entries"));
    }
    for (key, value) in choices {
        validate_field_id(key)?;
        let entries = value
            .as_array()
            .ok_or_else(|| invalid("choice sets must be arrays"))?;
        if entries.len() > MAX_COMPONENTS {
            return Err(invalid("a choice set exceeds 4096 entries"));
        }
        let (mut names, mut values) = (HashSet::new(), HashSet::new());
        for entry in entries {
            let choice: RawChoice = serde_json::from_value(entry.clone())
                .map_err(|e| invalid_owned(format!("invalid reusable choice: {e}")))?;
            bounded_text(&choice.name, "choice name")?;
            if choice.name.starts_with("raw:") {
                return Err(invalid("choice names cannot use the reserved raw: prefix"));
            }
            if !names.insert(choice.name) || !values.insert(choice.value) {
                return Err(invalid("choice names and values must be unique"));
            }
        }
    }
    Ok(())
}

fn visit_games(
    root: &mut Map<String, Value>,
    profiles: &Map<String, Value>,
    choices: &Map<String, Value>,
    budget: &mut usize,
) -> Result<()> {
    for profile in profiles.values() {
        let profile = profile
            .as_object()
            .ok_or_else(|| invalid("profiles must contain game property objects"))?;
        if profile.contains_key("profile") {
            return Err(invalid("profiles cannot reference another profile"));
        }
        if profile.contains_key("id") || profile.contains_key("name") {
            return Err(invalid("profiles cannot define id or name"));
        }
        let mut candidate = profile.clone();
        candidate.insert("id".into(), Value::String("profile-validation".into()));
        candidate.insert("name".into(), Value::String("Profile validation".into()));
        candidate
            .entry("platform")
            .or_insert(Value::String(String::new()));
        candidate.entry("save_size").or_insert(Value::from(1));
        candidate.entry("fields").or_insert(Value::Array(vec![]));
        visit_fields(&mut candidate, choices, budget)?;
        serde_json::from_value::<RawGame>(Value::Object(candidate))
            .map_err(|e| invalid_owned(format!("invalid profile properties: {e}")))?;
    }
    let games = root
        .get_mut("games")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("games must be an array"))?;
    if games.len() > MAX_GAMES {
        return Err(invalid("a save schema pack exceeds 64 games"));
    }
    for game in games {
        let game = object(game, "games must contain objects")?;
        let reference = match game.remove("profile") {
            None => None,
            Some(Value::String(s)) => Some(s),
            Some(_) => return Err(invalid("game profile references must be strings")),
        };
        if !game.contains_key("id") || !game.contains_key("name") {
            return Err(invalid("each game must define its own id and name"));
        }
        if let Some(name) = reference {
            let profile = profiles
                .get(&name)
                .and_then(Value::as_object)
                .ok_or_else(|| invalid("a game references an unknown profile"))?;
            charge(budget, profile)?;
            let overrides = std::mem::take(game);
            *game = profile.clone();
            game.extend(overrides);
        }
        visit_fields(game, choices, budget)?;
    }
    Ok(())
}

fn visit_records(
    root: &mut Map<String, Value>,
    choices: &Map<String, Value>,
    budget: &mut usize,
) -> Result<()> {
    let Some(records) = root.get_mut("records") else {
        return Ok(());
    };
    let records = records
        .as_object_mut()
        .ok_or_else(|| invalid("records must be an object"))?;
    if records.len() > MAX_COMPONENTS {
        return Err(invalid("record templates exceed 4096 entries"));
    }
    for (name, record) in records {
        validate_field_id(name)?;
        let fields = match record {
            Value::Array(a) => a,
            Value::Object(o) => match o.get_mut("fields") {
                None => continue,
                Some(Value::Array(fields)) => fields,
                Some(_) => return Err(invalid("record template fields must be an array")),
            },
            _ => return Err(invalid("record templates must be arrays or objects")),
        };
        for field in fields {
            visit_field(field, choices, budget)?;
        }
    }
    Ok(())
}

fn visit_fields(
    node: &mut Map<String, Value>,
    choices: &Map<String, Value>,
    budget: &mut usize,
) -> Result<()> {
    if let Some(fields) = node.get_mut("fields") {
        for field in fields
            .as_array_mut()
            .ok_or_else(|| invalid("fields must be an array"))?
        {
            visit_field(field, choices, budget)?;
        }
    }
    Ok(())
}

fn visit_field(field: &mut Value, choices: &Map<String, Value>, budget: &mut usize) -> Result<()> {
    let field = object(field, "fields must contain objects")?;
    let reference = field.remove("choices_ref");
    if reference.is_some() && field.contains_key("choices") {
        return Err(invalid(
            "a field cannot define both choices and choices_ref",
        ));
    }
    if let Some(reference) = reference {
        let name = reference
            .as_str()
            .ok_or_else(|| invalid("choices_ref must be a string"))?;
        let entries = choices
            .get(name)
            .ok_or_else(|| invalid("a field references an unknown choice set"))?;
        charge(budget, entries)?;
        field.insert("choices".into(), entries.clone());
    }
    Ok(())
}

fn charge<T: serde::Serialize>(budget: &mut usize, value: &T) -> Result<()> {
    *budget = budget.checked_add(size(value)?).ok_or_else(limit)?;
    if *budget > MAX_NORMALIZED_BYTES {
        return Err(limit());
    }
    Ok(())
}
fn size<T: serde::Serialize>(value: &T) -> Result<usize> {
    serde_json::to_vec(value)
        .map(|v| v.len())
        .map_err(|e| invalid_owned(format!("invalid save schema JSON: {e}")))
}
fn limit() -> crate::RomWeaverError {
    invalid("normalized save schema metadata exceeds 8 MiB")
}
fn object<'a>(value: &'a mut Value, message: &str) -> Result<&'a mut Map<String, Value>> {
    value.as_object_mut().ok_or_else(|| invalid(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> Value {
        serde_json::json!({"schema_version":1,"games":[{"id":"x","name":"X","platform":"p","save_size":2,"fields":[]}]})
    }
    #[test]
    fn expands_profiles_and_choices() {
        let mut v = base();
        v["profiles"] = serde_json::json!({"p":{"platform":"base","save_size":1,"fields":[]}});
        v["choices"] = serde_json::json!({"yes":[{"name":"Yes","value":1}]});
        v["games"][0]["profile"] = "p".into();
        v["games"][0]["platform"] = "override".into();
        v["games"][0]["fields"] = serde_json::json!([{"choices_ref":"yes"}]);
        let v = normalize(v).unwrap();
        assert_eq!(v["games"][0]["platform"], "override");
        assert_eq!(v["games"][0]["fields"][0]["choices"][0]["value"], 1);
    }
    #[test]
    fn visits_only_record_fields() {
        let mut v = base();
        v["choices"] = serde_json::json!({"x":[]});
        v["records"] = serde_json::json!({"r":{"fields":[{"choices_ref":"x"}],"records":[{"extra":{"choices_ref":"missing"}}]}});
        let v = normalize(v).unwrap();
        assert!(v["records"]["r"]["fields"][0].get("choices_ref").is_none());
        assert_eq!(
            v["records"]["r"]["records"][0]["extra"]["choices_ref"],
            "missing"
        );
    }

    #[test]
    fn permits_nested_record_only_templates() {
        let mut v = base();
        v["records"] = serde_json::json!({"outer":{"records":[{"record":"inner","id":"row","offset":0}]},"inner":[]});
        assert!(normalize(v).is_ok());
    }
    #[test]
    fn rejects_invalid_unused_definitions_and_references() {
        let mut v = base();
        v["profiles"] = serde_json::json!({"bad":{"unknown":true}});
        assert!(normalize(v).is_err());
        let mut v = base();
        v["choices"] = serde_json::json!({"bad":[{"name":"x","value":1,"extra":true}]});
        assert!(normalize(v).is_err());
        let mut v = base();
        v["games"][0]["profile"] = "missing".into();
        assert!(normalize(v).is_err());

        for forbidden in ["id", "name", "profile"] {
            let mut v = base();
            v["profiles"] = serde_json::json!({"bad":{"platform":"p","save_size":1,"fields":[],(forbidden):"x"}});
            assert!(
                normalize(v).is_err(),
                "accepted profile property {forbidden}"
            );
        }

        let mut v = base();
        v["games"][0]["fields"] = serde_json::json!([{"choices_ref":"missing"}]);
        assert!(normalize(v).is_err());

        let mut v = base();
        v["choices"] = serde_json::json!({"x":[]});
        v["games"][0]["fields"] = serde_json::json!([{"choices":[],"choices_ref":"x"}]);
        assert!(normalize(v).is_err());

        for choices in [
            serde_json::json!([{"name":"same","value":1},{"name":"same","value":2}]),
            serde_json::json!([{"name":"one","value":1},{"name":"two","value":1}]),
        ] {
            let mut v = base();
            v["choices"] = serde_json::json!({"bad":choices});
            assert!(normalize(v).is_err());
        }
    }

    #[test]
    fn leaves_unknown_properties_for_typed_deserialization() {
        let mut v = base();
        v["games"][0]["unknown"] = true.into();
        assert_eq!(normalize(v).unwrap()["games"][0]["unknown"], true);
    }

    #[test]
    fn strict_parser_rejects_duplicate_keys_at_every_depth() {
        for json in [
            r#"{"schema_version":1,"schema_version":1,"games":[]}"#,
            r#"{"schema_version":1,"games":[{"id":"a","id":"b"}]}"#,
            r#"{"schema_version":1,"games":[{"fields":[{"id":"a","id":"b"}]}]}"#,
        ] {
            assert!(from_json(json.as_bytes()).is_err());
        }
        assert!(from_json(serde_json::to_string(&base()).unwrap().as_bytes()).is_ok());
    }
    #[test]
    fn shared_expansion_budget_rejects_reuse_bomb() {
        let mut v = base();
        let text = "x".repeat(140_000);
        v["profiles"] =
            serde_json::json!({"p":{"platform":"p","save_size":1,"fields":[],"description":text}});
        v["games"] = Value::Array(
            (0..64)
                .map(|i| serde_json::json!({"id":format!("g{i}"),"name":"G","profile":"p"}))
                .collect(),
        );
        assert!(normalize(v).is_err());
    }
}
