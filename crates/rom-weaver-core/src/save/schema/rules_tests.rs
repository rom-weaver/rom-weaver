use super::{
    Storage,
    rules::{Check, Condition, ReadValue, Scalar, Store},
};
use crate::RomWeaverError;

#[test]
fn scalar_reads_and_writes_storage_with_masks() {
    let scalar = Scalar {
        offset: 1,
        storage: Storage::U16Be,
        mask: Some(0x0f00),
    };
    let mut bytes = [0xaa, 0x12, 0x34, 0xbb];
    assert_eq!(scalar.read(&bytes).unwrap(), 2);
    scalar.write(&mut bytes, 9).unwrap();
    assert_eq!(bytes, [0xaa, 0x19, 0x34, 0xbb]);
}

#[test]
fn scalar_rejects_out_of_bounds_access_and_values() {
    let scalar = Scalar {
        offset: 1,
        storage: Storage::U16Le,
        mask: None,
    };
    assert!(scalar.read(&[0]).is_err());
    assert!(scalar.write(&mut [0, 0, 0], -1).is_err());
    assert!(scalar.write(&mut [0, 0, 0], 65_536).is_err());
}

#[test]
fn callbacks_clone_and_propagate_errors() {
    let read = ReadValue::new(|bytes| {
        bytes
            .first()
            .copied()
            .map(i64::from)
            .ok_or_else(|| RomWeaverError::Validation("missing callback input".into()))
    });
    assert_eq!(read.clone().eval(&[7]).unwrap(), 7);
    assert!(read.eval(&[]).is_err());

    let condition = Condition::new(|bytes| Ok(bytes.first() == Some(&7)));
    assert!(condition.clone().test(&[7]).unwrap());
    assert!(!condition.test(&[8]).unwrap());
}

#[test]
fn check_honors_condition_and_returns_its_code() {
    let check = Check {
        when: Some(Condition::new(|bytes| Ok(bytes.first() == Some(&1)))),
        assert: Condition::new(|bytes| Ok(bytes.get(1) == Some(&2))),
        code: "coupled_value".into(),
        message: "values do not match".into(),
        section_id: None,
        warning: None,
    };
    assert!(check.run(&[0, 9]).is_ok());
    assert!(check.run(&[1, 2]).is_ok());
    let RomWeaverError::ValidationCode(error) = check.run(&[1, 9]).unwrap_err() else {
        panic!("the failed callback must return a validation code");
    };
    assert_eq!(error.code(), "coupled_value");
}

#[test]
fn store_applies_native_side_effect_after_testing_condition() {
    let store = Store {
        when: Some(Condition::new(|bytes| Ok(bytes.first() == Some(&3)))),
        destination: Scalar {
            offset: 1,
            storage: Storage::U8,
            mask: None,
        },
        value: ReadValue::new(|bytes| Ok(i64::from(bytes[0]) + 4)),
    };
    let mut bytes = [2, 0];
    store.apply(&mut bytes).unwrap();
    assert_eq!(bytes, [2, 0]);
    bytes[0] = 3;
    store.apply(&mut bytes).unwrap();
    assert_eq!(bytes, [3, 7]);
    assert!(store.validate(1).is_err());
}
