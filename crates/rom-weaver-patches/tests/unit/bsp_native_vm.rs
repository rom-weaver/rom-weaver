use std::fs;

use rom_weaver_core::RomWeaverError;

use super::{
    BSP_MAX_MESSAGE_BUFFER_LEN, BSP_MAX_STACK_LEN, BspVm, PatchSpace, StepControl, VmFileBuffer,
    apply_bsp_patch_file_native, apply_bsp_patch_file_native_from_path,
};
use crate::test_support::TestDir;

/// Distinct sentinel values loaded into variables 0-3 so a decoded "variable"
/// parameter can be told apart from a literal word in the same position.
const VARIABLE_SEED: [u32; 4] = [0xAAAA_0000, 0xBBBB_0001, 0xCCCC_0002, 0xDDDD_0003];
/// Little-endian encodings of `WORD_A`/`WORD_B` appear verbatim in the decoder
/// fixtures below.
const WORD_A: u32 = 0x4433_2211;
const WORD_B: u32 = 0x8877_6655;

/// Runs `body` against a VM whose patch space is `patch` and whose file buffer
/// is a real temp file seeded with `input`, then returns the body's value and
/// the file bytes the VM left behind.
fn run_vm_with_output<R>(
    patch: &[u8],
    input: &[u8],
    body: impl FnOnce(&mut BspVm<'static>) -> R,
) -> (R, Vec<u8>) {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    fs::write(&input_path, input).expect("input fixture");
    let mut vm: BspVm<'static> =
        BspVm::new(patch, &input_path, None).expect("BSP VM should open the input file");
    let result = body(&mut vm);
    drop(vm);
    let bytes = fs::read(&input_path).expect("VM output file");
    (result, bytes)
}

fn run_vm<R>(patch: &[u8], input: &[u8], body: impl FnOnce(&mut BspVm<'static>) -> R) -> R {
    run_vm_with_output(patch, input, body).0
}

fn step(vm: &mut BspVm<'static>, opcode: u8, args: &[u32]) -> StepControl {
    match vm.execute_opcode(opcode, args) {
        Ok(control) => control,
        Err(message) => panic!("opcode {opcode:#04x} should execute: {message}"),
    }
}

fn step_error(vm: &mut BspVm<'static>, opcode: u8, args: &[u32]) -> String {
    match vm.execute_opcode(opcode, args) {
        Ok(_) => panic!("opcode {opcode:#04x} should have failed"),
        Err(message) => message,
    }
}

fn assert_continue(control: StepControl) {
    if let StepControl::Exit(code) = control {
        panic!("expected the VM to continue, got exit {code}");
    }
}

fn assert_exit_code(control: StepControl, expected: u32) {
    match control {
        StepControl::Exit(code) => assert_eq!(code, expected),
        StepControl::Continue => panic!("expected exit {expected}, got continue"),
    }
}

fn set_ip(vm: &mut BspVm<'static>, instruction_pointer: u32) {
    vm.top_frame_mut().instruction_pointer = instruction_pointer;
}

fn seed_variables(vm: &mut BspVm<'static>) {
    for (index, value) in VARIABLE_SEED.iter().enumerate() {
        vm.set_variable(index as u8, *value);
    }
}

struct ParameterCase {
    opcode: u8,
    patch: &'static [u8],
    expected: &'static [u32],
}

#[test]
fn opcode_parameters_decodes_every_operand_shape() {
    let cases: &[ParameterCase] = &[
        ParameterCase {
            opcode: 0x00,
            patch: &[],
            expected: &[],
        },
        ParameterCase {
            opcode: 0x02,
            patch: &[0x11, 0x22, 0x33, 0x44],
            expected: &[WORD_A],
        },
        ParameterCase {
            opcode: 0x03,
            patch: &[0x01],
            expected: &[VARIABLE_SEED[1]],
        },
        ParameterCase {
            opcode: 0x10,
            patch: &[0x07, 0x11, 0x22, 0x33, 0x44],
            expected: &[7, WORD_A],
        },
        ParameterCase {
            opcode: 0x11,
            patch: &[0x07, 0x02],
            expected: &[7, VARIABLE_SEED[2]],
        },
        ParameterCase {
            opcode: 0x0A,
            patch: &[0x09],
            expected: &[9],
        },
        ParameterCase {
            opcode: 0x1A,
            patch: &[0x34, 0x12],
            expected: &[0x1234],
        },
        ParameterCase {
            opcode: 0x20,
            patch: &[0x05, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
            expected: &[5, WORD_A, WORD_B],
        },
        ParameterCase {
            opcode: 0x21,
            patch: &[0x05, 0x11, 0x22, 0x33, 0x44, 0x03],
            expected: &[5, WORD_A, VARIABLE_SEED[3]],
        },
        ParameterCase {
            opcode: 0x22,
            patch: &[0x05, 0x03, 0x11, 0x22, 0x33, 0x44],
            expected: &[5, VARIABLE_SEED[3], WORD_A],
        },
        ParameterCase {
            opcode: 0x23,
            patch: &[0x05, 0x01, 0x02],
            expected: &[5, VARIABLE_SEED[1], VARIABLE_SEED[2]],
        },
        ParameterCase {
            opcode: 0x40,
            patch: &[0x01, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
            expected: &[VARIABLE_SEED[1], WORD_A, WORD_B],
        },
        ParameterCase {
            opcode: 0x41,
            patch: &[0x01, 0x11, 0x22, 0x33, 0x44, 0x02],
            expected: &[VARIABLE_SEED[1], WORD_A, VARIABLE_SEED[2]],
        },
        ParameterCase {
            opcode: 0x42,
            patch: &[0x01, 0x02, 0x11, 0x22, 0x33, 0x44],
            expected: &[VARIABLE_SEED[1], VARIABLE_SEED[2], WORD_A],
        },
        ParameterCase {
            opcode: 0x43,
            patch: &[0x01, 0x02, 0x03],
            expected: &[VARIABLE_SEED[1], VARIABLE_SEED[2], VARIABLE_SEED[3]],
        },
        ParameterCase {
            opcode: 0x58,
            patch: &[0x01, 0x11, 0x22, 0x33, 0x44],
            expected: &[VARIABLE_SEED[1], WORD_A],
        },
        ParameterCase {
            opcode: 0x59,
            patch: &[0x01, 0x02],
            expected: &[VARIABLE_SEED[1], VARIABLE_SEED[2]],
        },
        ParameterCase {
            opcode: 0x6C,
            patch: &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
            expected: &[WORD_A, WORD_B],
        },
        ParameterCase {
            opcode: 0x6D,
            patch: &[0x11, 0x22, 0x33, 0x44, 0x02],
            expected: &[WORD_A, VARIABLE_SEED[2]],
        },
        ParameterCase {
            opcode: 0x70,
            patch: &[0x11, 0x22, 0x33, 0x44, 0x09],
            expected: &[WORD_A, 9],
        },
        ParameterCase {
            opcode: 0x72,
            patch: &[0x02, 0x09],
            expected: &[VARIABLE_SEED[2], 9],
        },
        ParameterCase {
            opcode: 0x74,
            patch: &[0x11, 0x22, 0x33, 0x44, 0x34, 0x12],
            expected: &[WORD_A, 0x1234],
        },
        ParameterCase {
            opcode: 0x76,
            patch: &[0x02, 0x34, 0x12],
            expected: &[VARIABLE_SEED[2], 0x1234],
        },
        ParameterCase {
            opcode: 0x98,
            patch: &[0x07, 0x09],
            expected: &[7, 9],
        },
        ParameterCase {
            opcode: 0xB0,
            patch: &[0x07, 0x09, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
            expected: &[7, 9, WORD_A, WORD_B],
        },
        ParameterCase {
            opcode: 0xB1,
            patch: &[0x07, 0x09, 0x11, 0x22, 0x33, 0x44, 0x02],
            expected: &[7, 9, WORD_A, VARIABLE_SEED[2]],
        },
        ParameterCase {
            opcode: 0xB2,
            patch: &[0x07, 0x09, 0x02, 0x11, 0x22, 0x33, 0x44],
            expected: &[7, 9, VARIABLE_SEED[2], WORD_A],
        },
        ParameterCase {
            opcode: 0xB3,
            patch: &[0x07, 0x09, 0x01, 0x02],
            expected: &[7, 9, VARIABLE_SEED[1], VARIABLE_SEED[2]],
        },
    ];

    for case in cases {
        let decoded = run_vm(case.patch, &[0u8; 4], |vm| {
            seed_variables(vm);
            vm.opcode_parameters(case.opcode)
                .expect("operands should decode")
        });
        assert_eq!(
            decoded, case.expected,
            "operand mismatch for opcode {:#04x}",
            case.opcode
        );
    }
}

#[test]
fn opcode_parameters_rejects_an_undefined_opcode() {
    let error = run_vm(&[], &[0u8; 4], |vm| {
        vm.opcode_parameters(0xC0)
            .expect_err("0xC0 has no operand shape")
    });
    assert_eq!(error, "undefined opcode");
}

#[test]
fn execute_opcode_rejects_an_undefined_opcode() {
    let error = run_vm(&[], &[0u8; 4], |vm| step_error(vm, 0xC0, &[]));
    assert_eq!(error, "undefined opcode");
}

#[test]
fn arithmetic_and_bitwise_opcodes_write_their_result_variable() {
    let cases: &[(u8, u32, u32, u32)] = &[
        (0x20, 7, 5, 12),
        (0x24, 5, 7, 0xFFFF_FFFE),
        (0x28, 6, 7, 42),
        (0x2C, 17, 5, 3),
        (0x30, 17, 5, 2),
        (0x34, 0b1100, 0b1010, 0b1000),
        (0x38, 0b1100, 0b1010, 0b1110),
        (0x3C, 0b1100, 0b1010, 0b0110),
    ];
    run_vm(&[], &[0u8; 4], |vm| {
        for (index, (opcode, first, second, expected)) in cases.iter().enumerate() {
            let variable = index as u8;
            assert_continue(step(vm, *opcode, &[u32::from(variable), *first, *second]));
            assert_eq!(
                vm.get_variable(variable),
                *expected,
                "result mismatch for opcode {opcode:#04x}"
            );
        }
    });
}

#[test]
fn conditional_jump_opcodes_branch_only_when_the_comparison_holds() {
    const TARGET: u32 = 0x1234;
    let cases: &[(u8, u32, u32, bool)] = &[
        (0x40, 1, 2, true),
        (0x40, 2, 1, false),
        (0x44, 2, 2, true),
        (0x44, 3, 2, false),
        (0x48, 3, 2, true),
        (0x48, 2, 3, false),
        (0x4C, 2, 2, true),
        (0x4C, 1, 2, false),
        (0x50, 4, 4, true),
        (0x50, 4, 5, false),
        (0x54, 4, 5, true),
        (0x54, 5, 5, false),
    ];
    run_vm(&[], &[0u8; 4], |vm| {
        for (opcode, first, second, taken) in cases {
            set_ip(vm, 0);
            assert_continue(step(vm, *opcode, &[*first, *second, TARGET]));
            let expected = if *taken { TARGET } else { 0 };
            assert_eq!(
                vm.top_frame().instruction_pointer,
                expected,
                "branch mismatch for opcode {opcode:#04x} with {first} vs {second}"
            );
        }
    });
}

#[test]
fn zero_test_conditional_opcodes_jump_and_call() {
    const TARGET: u32 = 0x4321;
    run_vm(&[], &[0u8; 4], |vm| {
        set_ip(vm, 0);
        assert_continue(step(vm, 0x58, &[0, TARGET]));
        assert_eq!(vm.top_frame().instruction_pointer, TARGET);

        set_ip(vm, 0);
        assert_continue(step(vm, 0x58, &[1, TARGET]));
        assert_eq!(vm.top_frame().instruction_pointer, 0);

        assert_continue(step(vm, 0x5A, &[1, TARGET]));
        assert_eq!(vm.top_frame().instruction_pointer, TARGET);

        set_ip(vm, 0);
        assert_continue(step(vm, 0x5A, &[0, TARGET]));
        assert_eq!(vm.top_frame().instruction_pointer, 0);

        assert_continue(step(vm, 0x5C, &[1, TARGET]));
        assert_eq!(vm.top_frame().stack.len(), 0);
        assert_continue(step(vm, 0x5C, &[0, TARGET]));
        assert_eq!(vm.top_frame().instruction_pointer, TARGET);
        assert_eq!(vm.top_frame().stack.len(), 1);

        set_ip(vm, 0);
        assert_continue(step(vm, 0x5E, &[0, TARGET]));
        assert_eq!(vm.top_frame().stack.len(), 1);
        assert_continue(step(vm, 0x5E, &[1, TARGET]));
        assert_eq!(vm.top_frame().instruction_pointer, TARGET);
        assert_eq!(vm.top_frame().stack.len(), 2);
    });
}

#[test]
fn control_flow_opcodes_manage_the_instruction_pointer_and_call_stack() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_continue(step(vm, 0x00, &[]));
        assert_exit_code(step(vm, 0x01, &[]), 0);

        set_ip(vm, 0x20);
        assert_continue(step(vm, 0x04, &[0x40]));
        assert_eq!(vm.top_frame().instruction_pointer, 0x40);
        assert_eq!(vm.top_frame().stack.len(), 1);

        assert_continue(step(vm, 0x01, &[]));
        assert_eq!(vm.top_frame().instruction_pointer, 0x20);
        assert_eq!(vm.top_frame().stack.len(), 0);

        assert_continue(step(vm, 0x02, &[0x88]));
        assert_eq!(vm.top_frame().instruction_pointer, 0x88);

        assert_exit_code(step(vm, 0x06, &[7]), 7);

        assert_continue(step(vm, 0x90, &[1]));
        assert_exit_code(step(vm, 0x90, &[0]), 0);
        assert_continue(step(vm, 0x91, &[0]));
        assert_exit_code(step(vm, 0x91, &[1]), 0);
    });
}

#[test]
fn file_pointer_opcodes_seek_relative_absolute_and_from_the_end() {
    run_vm(&[], &[0u8; 16], |vm| {
        assert_continue(step(vm, 0x60, &[10]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 10);

        assert_continue(step(vm, 0x62, &[5]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 15);

        assert_continue(step(vm, 0x64, &[5]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 10);

        assert_continue(step(vm, 0x66, &[4]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 12);

        assert_eq!(
            step_error(vm, 0x62, &[u32::MAX]),
            "current file pointer overflow"
        );
        assert_eq!(step_error(vm, 0x64, &[20]), "current file pointer overflow");
        assert_eq!(step_error(vm, 0x66, &[20]), "current file pointer overflow");
    });
}

#[test]
fn locking_the_file_pointer_freezes_every_seek_opcode() {
    run_vm(&[], &[0u8; 16], |vm| {
        assert_continue(step(vm, 0x60, &[12]));
        assert_continue(step(vm, 0x80, &[]));

        assert_continue(step(vm, 0x60, &[0]));
        assert_continue(step(vm, 0x62, &[1]));
        assert_continue(step(vm, 0x64, &[1]));
        assert_continue(step(vm, 0x66, &[0]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 12);

        assert_continue(step(vm, 0x81, &[]));
        assert_continue(step(vm, 0x60, &[3]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 3);
    });
}

#[test]
fn file_read_opcodes_honor_the_pointer_increment_flag() {
    run_vm(&[], &[0x11, 0x22, 0x33, 0x44, 0x55], |vm| {
        assert_continue(step(vm, 0xAC, &[0]));
        assert_continue(step(vm, 0xAD, &[1]));
        assert_continue(step(vm, 0xAE, &[2]));
        assert_eq!(vm.get_variable(0), 0x11);
        assert_eq!(vm.get_variable(1), 0x2211);
        assert_eq!(vm.get_variable(2), 0x4433_2211);
        assert_continue(step(vm, 0x0F, &[3]));
        assert_eq!(vm.get_variable(3), 0, "0xAC-0xAE must not move the pointer");

        assert_continue(step(vm, 0x0C, &[4]));
        assert_eq!(vm.get_variable(4), 0x11);
        assert_continue(step(vm, 0x0D, &[5]));
        assert_eq!(vm.get_variable(5), 0x3322);
        assert_continue(step(vm, 0x0F, &[6]));
        assert_eq!(vm.get_variable(6), 3);

        assert_continue(step(vm, 0x60, &[0]));
        assert_continue(step(vm, 0x0E, &[7]));
        assert_eq!(vm.get_variable(7), 0x4433_2211);
        assert_continue(step(vm, 0x0F, &[8]));
        assert_eq!(vm.get_variable(8), 4);

        assert_continue(step(vm, 0x0B, &[9]));
        assert_eq!(vm.get_variable(9), 5);
    });
}

#[test]
fn file_write_opcodes_emit_little_endian_values_and_advance_the_pointer() {
    let (_, output) = run_vm_with_output(&[], &[], |vm| {
        assert_continue(step(vm, 0x18, &[0xAA]));
        assert_continue(step(vm, 0x1A, &[0x1234]));
        assert_continue(step(vm, 0x1C, &[0x8877_6655]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 7);
    });
    assert_eq!(output, vec![0xAA, 0x34, 0x12, 0x55, 0x66, 0x77, 0x88]);
}

#[test]
fn file_write_opcodes_reject_a_pointer_at_the_end_of_the_address_space() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_continue(step(vm, 0x60, &[0xFFFF_FFFF]));
        assert_eq!(step_error(vm, 0x18, &[0]), "current file pointer overflow");
        assert_continue(step(vm, 0x60, &[0xFFFF_FFFE]));
        assert_eq!(step_error(vm, 0x1A, &[0]), "current file pointer overflow");
        assert_continue(step(vm, 0x60, &[0xFFFF_FFFC]));
        assert_eq!(step_error(vm, 0x1C, &[0]), "current file pointer overflow");
    });
}

#[test]
fn truncate_opcodes_shrink_the_file_buffer() {
    let (_, output) = run_vm_with_output(&[], &[0x01, 0x02, 0x03, 0x04, 0x05], |vm| {
        assert_continue(step(vm, 0x60, &[3]));
        assert_continue(step(vm, 0x82, &[]));
        assert_continue(step(vm, 0x0B, &[0]));
        assert_eq!(vm.get_variable(0), 3);
    });
    assert_eq!(output, vec![0x01, 0x02, 0x03]);
}

#[test]
fn patch_space_read_opcodes_load_bytes_halfwords_and_words() {
    let patch = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
    run_vm(&patch, &[0u8; 4], |vm| {
        assert_continue(step(vm, 0x10, &[0, 1]));
        assert_eq!(vm.get_variable(0), 0x22);
        assert_continue(step(vm, 0x12, &[0, 1]));
        assert_eq!(vm.get_variable(0), 0x3322);
        assert_continue(step(vm, 0x14, &[0, 0]));
        assert_eq!(vm.get_variable(0), 0x4433_2211);
    });
}

#[test]
fn indexed_patch_read_opcodes_step_their_address_variable() {
    let patch = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
    run_vm(&patch, &[0u8; 4], |vm| {
        vm.set_variable(1, 2);
        assert_continue(step(vm, 0x98, &[0, 1]));
        assert_eq!(vm.get_variable(0), 0x33);
        assert_eq!(vm.get_variable(1), 3);

        vm.set_variable(1, 3);
        assert_continue(step(vm, 0x99, &[0, 1]));
        assert_eq!(vm.get_variable(0), 0x5544);
        assert_eq!(vm.get_variable(1), 5);

        vm.set_variable(1, 0);
        assert_continue(step(vm, 0x9A, &[0, 1]));
        assert_eq!(vm.get_variable(0), 0x4433_2211);
        assert_eq!(vm.get_variable(1), 4);

        vm.set_variable(1, 4);
        assert_continue(step(vm, 0x9C, &[0, 1]));
        assert_eq!(vm.get_variable(0), 0x55);
        assert_eq!(vm.get_variable(1), 3);

        vm.set_variable(1, 4);
        assert_continue(step(vm, 0x9D, &[0, 1]));
        assert_eq!(vm.get_variable(0), 0x6655);
        assert_eq!(vm.get_variable(1), 2);

        vm.set_variable(1, 4);
        assert_continue(step(vm, 0x9E, &[0, 1]));
        assert_eq!(vm.get_variable(0), 0x8877_6655);
        assert_eq!(vm.get_variable(1), 0);

        vm.set_variable(2, 41);
        assert_continue(step(vm, 0x9B, &[2]));
        assert_eq!(vm.get_variable(2), 42);
        assert_continue(step(vm, 0x9F, &[2]));
        assert_eq!(vm.get_variable(2), 41);

        vm.set_variable(3, 0);
        assert_continue(step(vm, 0x9F, &[3]));
        assert_eq!(vm.get_variable(3), u32::MAX);

        assert_continue(step(vm, 0xAF, &[4, 2]));
        assert_eq!(vm.get_variable(4), 41);
    });
}

#[test]
fn stack_opcodes_index_from_both_ends_and_reject_out_of_range_positions() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_continue(step(vm, 0x08, &[10]));
        assert_continue(step(vm, 0x08, &[20]));
        assert_continue(step(vm, 0x08, &[30]));

        assert_continue(step(vm, 0xAA, &[0]));
        assert_eq!(vm.get_variable(0), 3);

        assert_continue(step(vm, 0x8C, &[1, 0]));
        assert_eq!(vm.get_variable(1), 30);

        // 0xFFFF_FFFF is -1, which indexes the last (deepest) stack entry.
        assert_continue(step(vm, 0x8C, &[2, 0xFFFF_FFFF]));
        assert_eq!(vm.get_variable(2), 10);

        assert_continue(step(vm, 0x88, &[0, 99]));
        assert_continue(step(vm, 0x8C, &[3, 0]));
        assert_eq!(vm.get_variable(3), 99);

        assert_eq!(step_error(vm, 0x8C, &[4, 5]), "invalid stack position");
        assert_eq!(step_error(vm, 0x88, &[5, 0]), "invalid stack position");

        assert_continue(step(vm, 0x0A, &[4]));
        assert_eq!(vm.get_variable(4), 99);
        assert_continue(step(vm, 0xAA, &[5]));
        assert_eq!(vm.get_variable(5), 2);
    });
}

#[test]
fn stack_shift_opcode_grows_and_shrinks_relative_to_the_current_length() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_continue(step(vm, 0xA8, &[4]));
        assert_continue(step(vm, 0x8E, &[0xFFFF_FFFF]));
        assert_continue(step(vm, 0xAA, &[0]));
        assert_eq!(vm.get_variable(0), 3);

        assert_continue(step(vm, 0x8E, &[3]));
        assert_continue(step(vm, 0xAA, &[0]));
        assert_eq!(vm.get_variable(0), 6);

        assert_eq!(step_error(vm, 0x8E, &[0xFFFF_FFF0]), "stack underflow");
    });
}

#[test]
fn file_pointer_stack_opcodes_round_trip_the_pointer() {
    run_vm(&[], &[0u8; 16], |vm| {
        assert_continue(step(vm, 0x60, &[7]));
        assert_continue(step(vm, 0x92, &[]));
        assert_continue(step(vm, 0x60, &[0]));
        assert_continue(step(vm, 0x93, &[]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 7);
    });
}

#[test]
fn push_to_stack_refuses_to_grow_past_the_stack_ceiling() {
    run_vm(&[], &[0u8; 1], |vm| {
        vm.resize_stack(BSP_MAX_STACK_LEN as u32)
            .expect("resize to the ceiling");
        let error = vm
            .push_to_stack(1)
            .expect_err("a push past the ceiling must be rejected");
        assert!(
            error.contains("BSP stack exceeded the maximum"),
            "unexpected error: {error}"
        );
    });
}

#[test]
fn fill_opcodes_repeat_byte_halfword_and_word_patterns() {
    let (_, output) = run_vm_with_output(&[], &[], |vm| {
        assert_continue(step(vm, 0x70, &[4, 0xAA]));
        assert_continue(step(vm, 0x74, &[2, 0x1234]));
        assert_continue(step(vm, 0x78, &[1, 0xDEAD_BEEF]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 12);

        // A zero count is a no-op that leaves the pointer alone.
        assert_continue(step(vm, 0x70, &[0, 0xFF]));
        assert_continue(step(vm, 0x74, &[0, 0xFFFF]));
        assert_continue(step(vm, 0x78, &[0, 0xFFFF_FFFF]));
        assert_continue(step(vm, 0x0F, &[1]));
        assert_eq!(vm.get_variable(1), 12);
    });
    assert_eq!(
        output,
        vec![
            0xAA, 0xAA, 0xAA, 0xAA, 0x34, 0x12, 0x34, 0x12, 0xEF, 0xBE, 0xAD, 0xDE
        ]
    );
}

#[test]
fn fill_file_pattern_returns_the_position_unchanged_for_empty_work() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_eq!(
            vm.fill_file_pattern(7, &[], 5).expect("empty pattern"),
            7,
            "an empty pattern must not move the write cursor"
        );
        assert_eq!(vm.fill_file_pattern(7, &[0xAA], 0).expect("zero count"), 7);
    });
}

#[test]
fn fill_opcodes_reject_a_run_that_leaves_the_address_space() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_continue(step(vm, 0x60, &[0xFFFF_FFF0]));
        assert_eq!(
            step_error(vm, 0x70, &[0x20, 0xAA]),
            "file position overflow"
        );
    });
}

#[test]
fn copy_or_xor_opcode_appends_when_the_pointer_is_past_the_end() {
    let patch = [0xFF, 0x0F, 0xAA, 0xBB];
    let (_, output) = run_vm_with_output(&patch, &[0x01, 0x02], |vm| {
        assert_continue(step(vm, 0x60, &[4]));
        assert_continue(step(vm, 0x6C, &[2, 2]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 6);
    });
    assert_eq!(output, vec![0x01, 0x02, 0x00, 0x00, 0xAA, 0xBB]);
}

#[test]
fn copy_or_xor_opcode_splits_at_the_end_of_the_file() {
    let patch = [0xFF, 0x0F, 0xAA, 0xBB];
    let (_, output) = run_vm_with_output(&patch, &[0x10, 0x20, 0x30], |vm| {
        assert_continue(step(vm, 0x60, &[1]));
        assert_continue(step(vm, 0x6C, &[0, 4]));
        assert_continue(step(vm, 0x0F, &[0]));
        assert_eq!(vm.get_variable(0), 5);
    });
    assert_eq!(output, vec![0x10, 0xDF, 0x3F, 0xAA, 0xBB]);
}

#[test]
fn copy_or_xor_opcode_reports_a_patch_overrun_in_its_appended_tail() {
    // The pointer sits one byte inside a 3-byte file, so the first two bytes
    // fold onto xor_data and the remaining two onto write_data. The write half
    // runs off the end of the 4-byte patch space, which must surface as an
    // error rather than a short write.
    let patch = [0xFF, 0x0F, 0xAA, 0xBB];
    run_vm(&patch, &[0x10, 0x20, 0x30], |vm| {
        assert_continue(step(vm, 0x60, &[1]));
        assert_eq!(
            step_error(vm, 0x6C, &[2, 4]),
            "attempted to read past the end of the patch space"
        );
    });
}

#[test]
fn data_movement_opcodes_reject_runs_that_leave_the_address_space() {
    let patch = [0xFF, 0x0F, 0xAA, 0xBB];
    run_vm(&patch, &[0x10, 0x20], |vm| {
        assert_continue(step(vm, 0x60, &[0xFFFF_FFFF]));
        assert_eq!(step_error(vm, 0x6C, &[0, 1]), "file position overflow");
        assert_eq!(step_error(vm, 0x7C, &[0, 1]), "file position overflow");
    });
}

#[test]
fn write_data_and_xor_data_validate_both_address_spaces() {
    run_vm(&[0xFF, 0x0F, 0xAA, 0xBB], &[0x10, 0x20], |vm| {
        vm.write_data(0, 0, 0)
            .expect("a zero-length write is a no-op");
        vm.xor_data(0, 0, 0).expect("a zero-length xor is a no-op");

        assert_eq!(
            vm.write_data(0, 2, 10).expect_err("patch overrun"),
            "attempted to read past the end of the patch space"
        );
        assert_eq!(
            vm.write_data(0, u32::MAX, 2).expect_err("patch overflow"),
            "attempted to read past the end of the patch space"
        );
        assert_eq!(
            vm.xor_data(0, 2, 10).expect_err("patch overrun"),
            "attempted to read past the end of the patch space"
        );
        assert_eq!(
            vm.xor_data(0, u32::MAX, 2).expect_err("patch overflow"),
            "attempted to read past the end of the patch space"
        );
        assert_eq!(
            vm.xor_data(0, 0, 4).expect_err("file overrun"),
            "attempted to read past the end of the file buffer"
        );
        assert_eq!(
            vm.xor_data(u32::MAX, 0, 2).expect_err("file overflow"),
            "attempted to read past the end of the file buffer"
        );
        assert_eq!(
            vm.write_data(u32::MAX, 0, 2).expect_err("file overflow"),
            "file buffer size overflow"
        );
    });
}

#[test]
fn set_file_value_helpers_reject_positions_that_overflow_the_address_space() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_eq!(
            vm.set_file_byte(u32::MAX, 0).expect_err("byte overflow"),
            "file buffer size overflow"
        );
        assert_eq!(
            vm.set_file_halfword(u32::MAX, 0)
                .expect_err("halfword overflow"),
            "file buffer size overflow"
        );
        assert_eq!(
            vm.set_file_word(u32::MAX, 0).expect_err("word overflow"),
            "file buffer size overflow"
        );
    });
}

#[test]
fn print_opcodes_accumulate_and_clear_the_message_buffer() {
    let mut patch = vec![0u8; 8];
    patch.extend_from_slice(b"Hi\0");
    run_vm(&patch, &[0u8; 4], |vm| {
        assert_continue(step(vm, 0xA0, &[8]));
        assert_eq!(vm.top_frame().message_buffer, "Hi");

        assert_continue(step(vm, 0xA2, &[u32::from(b'!')]));
        assert_eq!(vm.top_frame().message_buffer, "Hi!");

        // Codepoint zero is the documented "append nothing" case.
        assert_continue(step(vm, 0xA2, &[0]));
        assert_eq!(vm.top_frame().message_buffer, "Hi!");

        assert_continue(step(vm, 0xA4, &[1234]));
        assert_eq!(vm.top_frame().message_buffer, "Hi!1234");

        assert_continue(step(vm, 0xA6, &[]));
        assert_eq!(vm.top_frame().message_buffer, "");

        assert_continue(step(vm, 0xA4, &[7]));
        assert_continue(step(vm, 0xA7, &[]));
        assert_eq!(vm.top_frame().message_buffer, "");

        assert_eq!(
            step_error(vm, 0xA2, &[0xD800]),
            "invalid Unicode character",
            "surrogate halves are not valid scalar values"
        );
    });
}

#[test]
fn utf8_decode_rejects_a_string_longer_than_the_message_buffer_ceiling() {
    let patch = vec![b'A'; BSP_MAX_MESSAGE_BUFFER_LEN + 1];
    run_vm(&patch, &[0u8; 1], |vm| {
        let error = vm
            .utf8_decode(0)
            .expect_err("an unterminated string must be capped");
        assert!(
            error.contains("BSP decoded string exceeded the maximum size"),
            "unexpected error: {error}"
        );
    });
}

#[test]
fn menu_opcode_selects_the_first_entry_and_reports_an_empty_table() {
    let mut patch = Vec::new();
    patch.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    patch.extend_from_slice(&12u32.to_le_bytes());
    patch.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    patch.extend_from_slice(b"Hi\0");
    run_vm(&patch, &[0u8; 4], |vm| {
        assert_continue(step(vm, 0x6A, &[0, 0]));
        assert_eq!(vm.get_variable(0), 0xFFFF_FFFF);

        assert_continue(step(vm, 0x6A, &[1, 4]));
        assert_eq!(vm.get_variable(1), 0);
    });
}

#[test]
fn jump_table_opcode_follows_the_indexed_entry() {
    let mut patch = vec![0x00, 0x00];
    patch.extend_from_slice(&0x1111u32.to_le_bytes());
    patch.extend_from_slice(&0x2222u32.to_le_bytes());
    run_vm(&patch, &[0u8; 4], |vm| {
        set_ip(vm, 2);
        assert_continue(step(vm, 0x83, &[1]));
        assert_eq!(vm.top_frame().instruction_pointer, 0x2222);

        set_ip(vm, 2);
        assert_eq!(
            step_error(vm, 0x83, &[3]),
            "attempted to read past the end of the patch space"
        );

        set_ip(vm, 2);
        assert_eq!(
            step_error(vm, 0x83, &[0x4000_0000]),
            "attempted to read past the end of the patch space"
        );
    });
}

#[test]
fn bit_shift_opcode_covers_every_shift_type_and_operand_source() {
    // Byte 4 selects variable 1 (the shift-count source), byte 5 selects
    // variable 3 (the value source); the leading word is the literal operand.
    let patch = [0xF0, 0x00, 0x00, 0x00, 0x01, 0x03];
    run_vm(&patch, &[0u8; 4], |vm| {
        vm.set_variable(1, 8);
        vm.set_variable(3, 0xFFFF_FF00);

        set_ip(vm, 0);
        assert_continue(step(vm, 0xAB, &[0x04, 10]));
        assert_eq!(vm.get_variable(10), 0xF00);

        set_ip(vm, 0);
        assert_continue(step(vm, 0xAB, &[0x24, 11]));
        assert_eq!(vm.get_variable(11), 0x0F);

        set_ip(vm, 0);
        assert_continue(step(vm, 0xAB, &[0x44, 12]));
        assert_eq!(vm.get_variable(12), 0xF00);

        set_ip(vm, 5);
        assert_continue(step(vm, 0xAB, &[0xE4, 13]));
        assert_eq!(vm.get_variable(13), 0xFFFF_FFF0);

        set_ip(vm, 5);
        assert_continue(step(vm, 0xAB, &[0x84, 14]));
        assert_eq!(vm.get_variable(14), 0xFFFF_F000);

        // A zero shift count in the flags byte reads the count from a variable.
        set_ip(vm, 0);
        assert_continue(step(vm, 0xAB, &[0x00, 15]));
        assert_eq!(vm.get_variable(15), 0xF000);
    });
}

#[test]
fn add_with_carry_opcode_tracks_the_carry_variable() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_continue(step(vm, 0xB0, &[0, 1, 1, 2]));
        assert_eq!(vm.get_variable(0), 3);
        assert_eq!(vm.get_variable(1), 0);

        vm.set_variable(1, 5);
        assert_continue(step(vm, 0xB0, &[0, 1, 0xFFFF_FFFF, 2]));
        assert_eq!(vm.get_variable(0), 1);
        assert_eq!(vm.get_variable(1), 6);

        // When the result and carry share a variable, only the carry is kept.
        vm.set_variable(2, 0);
        assert_continue(step(vm, 0xB0, &[2, 2, 0xFFFF_FFFF, 2]));
        assert_eq!(vm.get_variable(2), 1);
    });
}

#[test]
fn subtract_with_borrow_opcode_tracks_the_borrow_variable() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_continue(step(vm, 0xB4, &[3, 4, 7, 5]));
        assert_eq!(vm.get_variable(3), 2);
        assert_eq!(vm.get_variable(4), 0);

        vm.set_variable(4, 5);
        assert_continue(step(vm, 0xB4, &[3, 4, 2, 5]));
        assert_eq!(vm.get_variable(3), 0xFFFF_FFFD);
        assert_eq!(vm.get_variable(4), 4);

        vm.set_variable(5, 3);
        assert_continue(step(vm, 0xB4, &[5, 5, 1, 2]));
        assert_eq!(vm.get_variable(5), 2);
    });
}

#[test]
fn wide_multiply_opcodes_split_the_product_across_two_variables() {
    run_vm(&[], &[0u8; 4], |vm| {
        assert_continue(step(vm, 0xB8, &[6, 7, 0x1_0000, 0x1_0000]));
        assert_eq!(vm.get_variable(6), 0);
        assert_eq!(vm.get_variable(7), 1);

        // A shared destination keeps only the high word.
        assert_continue(step(vm, 0xB8, &[8, 8, 0x1_0000, 0x1_0000]));
        assert_eq!(vm.get_variable(8), 1);
    });
}

#[test]
fn multiply_accumulate_opcodes_add_the_product_into_the_destination_pair() {
    run_vm(&[], &[0u8; 4], |vm| {
        vm.set_variable(9, 10);
        assert_continue(step(vm, 0xBC, &[9, 9, 3, 4]));
        assert_eq!(vm.get_variable(9), 22);

        vm.set_variable(10, 0xFFFF_FFFF);
        vm.set_variable(11, 0);
        assert_continue(step(vm, 0xBC, &[10, 11, 1, 2]));
        assert_eq!(vm.get_variable(10), 1);
        assert_eq!(vm.get_variable(11), 1);

        vm.set_variable(12, 1);
        vm.set_variable(13, 2);
        assert_continue(step(vm, 0xBC, &[12, 13, 0x1_0000, 0x1_0000]));
        assert_eq!(vm.get_variable(12), 1);
        assert_eq!(vm.get_variable(13), 3);
    });
}

#[test]
fn update_hashes_digests_the_file_once_per_write() {
    const ABC_SHA1: [u8; 20] = [
        0xA9, 0x99, 0x3E, 0x36, 0x47, 0x06, 0x81, 0x6A, 0xBA, 0x3E, 0x25, 0x71, 0x78, 0x50, 0xC2,
        0x6C, 0x9C, 0xD0, 0xD8, 0x9D,
    ];
    run_vm(&[], b"abc", |vm| {
        vm.update_hashes().expect("first digest");
        assert_eq!(vm.sha1, ABC_SHA1);
        // The second call must short-circuit on the clean flag.
        vm.update_hashes().expect("cached digest");
        assert_eq!(vm.sha1, ABC_SHA1);
    });
}

#[test]
fn nested_bsppatch_rejects_a_region_outside_the_patch_space() {
    run_vm(&[0x00; 8], &[0u8; 4], |vm| {
        assert_eq!(
            step_error(vm, 0x94, &[0, 4, 100]),
            "attempted to read past the end of the patch space"
        );
    });
}

#[test]
fn patch_space_reads_are_bounded_by_its_length() {
    let space = PatchSpace::Owned(vec![0x11, 0x22, 0x33, 0x44]);
    assert_eq!(space.len(), 4);
    assert_eq!(space.read_byte(3).expect("byte"), 0x44);
    assert_eq!(space.read_halfword(1).expect("halfword"), 0x3322);
    assert_eq!(space.read_word(0).expect("word"), 0x4433_2211);
    assert_eq!(space.read_vec(1, 2).expect("slice"), vec![0x22, 0x33]);

    assert_eq!(
        space.read_word(1).expect_err("word overrun"),
        "attempted to read past the end of the patch space"
    );
    assert_eq!(
        space.read_byte(4).expect_err("byte overrun"),
        "attempted to read past the end of the patch space"
    );
    assert_eq!(
        space
            .read_vec(usize::MAX, 2)
            .expect_err("start position overflow"),
        "attempted to read past the end of the patch space"
    );
}

#[test]
fn file_buffer_rejects_reads_and_writes_outside_its_length() {
    let temp = TestDir::new();
    let path = temp.child("buffer.bin");
    fs::write(&path, [0x01, 0x02, 0x03, 0x04]).expect("fixture");
    let mut buffer = VmFileBuffer::open(&path).expect("open");
    assert_eq!(buffer.len(), 4);

    assert_eq!(
        buffer
            .write_at(3, &[0x00, 0x00])
            .expect_err("write overrun"),
        "attempted to write past the end of the file buffer"
    );
    assert_eq!(
        buffer
            .write_at(usize::MAX, &[0x00])
            .expect_err("write overflow"),
        "file buffer size overflow"
    );
    assert_eq!(
        buffer
            .read_exact_at(3, &mut [0u8; 2])
            .expect_err("read overrun"),
        "attempted to read past the end of the file buffer"
    );
    assert_eq!(
        buffer
            .read_exact_at(usize::MAX, &mut [0u8; 2])
            .expect_err("read overflow"),
        "file buffer size overflow"
    );
    assert_eq!(
        buffer.xor_range(3, &[0x00, 0x00]).expect_err("xor overrun"),
        "attempted to read past the end of the file buffer"
    );
    assert_eq!(
        buffer
            .xor_range(usize::MAX, &[0x00, 0x00])
            .expect_err("xor overflow"),
        "attempted to read past the end of the file buffer"
    );

    buffer
        .write_range(0, &[])
        .expect("an empty write is a no-op");
    buffer.xor_range(0, &[]).expect("an empty xor is a no-op");
    assert_eq!(
        fs::read(&path).expect("unchanged"),
        [0x01, 0x02, 0x03, 0x04]
    );
}

#[test]
fn file_buffer_grows_truncates_and_hashes() {
    let temp = TestDir::new();
    let path = temp.child("buffer.bin");
    fs::write(&path, [0x01, 0x02]).expect("fixture");
    let mut buffer = VmFileBuffer::open(&path).expect("open");

    buffer.ensure_size(1).expect("shrinking is not a growth");
    assert_eq!(buffer.len(), 2);
    buffer.ensure_size(5).expect("grow");
    assert_eq!(buffer.len(), 5);
    buffer.write_range(2, &[0xAA, 0xBB]).expect("write");
    assert_eq!(
        buffer.read_vec_at(0, 5).expect("read back"),
        vec![0x01, 0x02, 0xAA, 0xBB, 0x00]
    );

    buffer.xor_range(0, &[0xFF, 0x0F]).expect("xor");
    assert_eq!(
        buffer.read_vec_at(0, 2).expect("read back"),
        vec![0xFE, 0x0D]
    );

    buffer.truncate(3).expect("truncate");
    assert_eq!(buffer.len(), 3);
    assert_eq!(fs::read(&path).expect("file"), [0xFE, 0x0D, 0xAA]);

    let empty_path = temp.child("empty.bin");
    fs::write(&empty_path, []).expect("fixture");
    let mut empty = VmFileBuffer::open(&empty_path).expect("open");
    assert_eq!(
        empty.sha1_digest().expect("digest"),
        [
            0xDA, 0x39, 0xA3, 0xEE, 0x5E, 0x6B, 0x4B, 0x0D, 0x32, 0x55, 0xBF, 0xEF, 0x95, 0x60,
            0x18, 0x90, 0xAF, 0xD8, 0x07, 0x09
        ]
    );
}

#[test]
fn file_buffer_open_reports_a_missing_path() {
    let temp = TestDir::new();
    let error = match VmFileBuffer::open(&temp.child("missing.bin")) {
        Ok(_) => panic!("opening a missing file must fail"),
        Err(message) => message,
    };
    assert!(
        error.starts_with("failed to open BSP file buffer:"),
        "unexpected error: {error}"
    );
}

/// A BSP program whose only opcode is `ipspatch` (0x86) over an embedded IPS
/// stream, followed by `exit 0`. The stream starts at offset 11, which is where
/// the fixed 11-byte prologue ends.
fn ipspatch_program(stream: &[u8]) -> Vec<u8> {
    let mut patch = vec![0x86, 0x00];
    patch.extend_from_slice(&11u32.to_le_bytes());
    patch.push(0x06);
    patch.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(patch.len(), 11);
    patch.extend_from_slice(stream);
    patch
}

#[test]
fn ipspatch_opcode_applies_literal_and_run_length_records() {
    let mut stream = Vec::new();
    stream.extend_from_slice(b"PATCH");
    stream.extend_from_slice(&[0x00, 0x00, 0x01, 0x00, 0x02, 0xAA, 0xBB]);
    stream.extend_from_slice(&[0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0xCC]);
    // A run of length zero exercises the empty-fill shortcut.
    stream.extend_from_slice(&[0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0xDD]);
    stream.extend_from_slice(b"EOF");
    let patch = ipspatch_program(&stream);

    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    fs::write(&input_path, [0u8; 12]).expect("fixture");
    let length = apply_bsp_patch_file_native(&patch, &input_path, None).expect("ipspatch applies");

    assert_eq!(length, 12);
    assert_eq!(
        fs::read(&input_path).expect("output"),
        vec![
            0x00, 0xAA, 0xBB, 0x00, 0xCC, 0xCC, 0xCC, 0x00, 0x00, 0x00, 0x00, 0x00
        ]
    );
}

#[test]
fn ipspatch_opcode_rejects_records_that_leave_the_address_space() {
    let mut stream = Vec::new();
    stream.extend_from_slice(b"PATCH");
    stream.extend_from_slice(&[0x00, 0x00, 0x01, 0x00, 0x01, 0xFF]);
    stream.extend_from_slice(b"EOF");

    run_vm(&stream, &[0u8; 4], |vm| {
        vm.update_current_file_pointer(u32::MAX);
        assert_eq!(
            vm.ipspatch_opcode(0, 0)
                .expect_err("offset addition overflow"),
            "file position overflow"
        );

        vm.update_current_file_pointer(0xFFFF_FFFE);
        assert_eq!(
            vm.ipspatch_opcode(0, 0)
                .expect_err("the last address is not writable"),
            "file position overflow"
        );
    });
}

/// Writes a patch-space word and halfword into the file so a `from_path` run
/// exercises the block-cache-backed `PatchSpace::Cached` reads.
fn cached_patch_program() -> Vec<u8> {
    let mut patch = vec![0x60];
    patch.extend_from_slice(&0u32.to_le_bytes());
    patch.extend_from_slice(&[0x14, 0x00]);
    patch.extend_from_slice(&26u32.to_le_bytes());
    patch.extend_from_slice(&[0x1D, 0x00]);
    patch.extend_from_slice(&[0x12, 0x01]);
    patch.extend_from_slice(&26u32.to_le_bytes());
    patch.extend_from_slice(&[0x1B, 0x01]);
    patch.push(0x06);
    patch.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(patch.len(), 26);
    patch.extend_from_slice(&[0x11, 0x22, 0x33, 0x44]);
    patch
}

#[test]
fn apply_from_path_reads_the_patch_through_the_block_cache() {
    let temp = TestDir::new();
    let patch_path = temp.child("update.bsp");
    let input_path = temp.child("input.bin");
    fs::write(&patch_path, cached_patch_program()).expect("patch fixture");
    fs::write(&input_path, [0u8; 8]).expect("input fixture");

    let length =
        apply_bsp_patch_file_native_from_path(&patch_path, &input_path, None).expect("apply");

    assert_eq!(length, 8);
    assert_eq!(
        fs::read(&input_path).expect("output"),
        vec![0x11, 0x22, 0x33, 0x44, 0x11, 0x22, 0x00, 0x00]
    );
}

#[test]
fn apply_from_path_surfaces_a_missing_patch_file() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    fs::write(&input_path, [0u8; 4]).expect("input fixture");

    let error =
        apply_bsp_patch_file_native_from_path(&temp.child("missing.bsp"), &input_path, None)
            .expect_err("a missing patch must fail");
    assert!(
        matches!(&error, RomWeaverError::Validation(message)
            if message.contains("failed to read BSP patch metadata")),
        "unexpected error: {error:?}"
    );
}

#[test]
fn apply_from_path_surfaces_a_failure_exit_status_and_a_runtime_error() {
    let temp = TestDir::new();
    let input_path = temp.child("input.bin");
    fs::write(&input_path, [0u8; 4]).expect("input fixture");

    let exit_path = temp.child("exit.bsp");
    fs::write(&exit_path, [0x06, 0x02, 0x00, 0x00, 0x00]).expect("patch fixture");
    let error = apply_bsp_patch_file_native_from_path(&exit_path, &input_path, None)
        .expect_err("a non-zero exit must fail");
    assert!(
        matches!(&error, RomWeaverError::Validation(message)
            if message.contains("BSP patch script exited with failure status 2")),
        "unexpected error: {error:?}"
    );

    let broken_path = temp.child("broken.bsp");
    fs::write(&broken_path, [0xC0]).expect("patch fixture");
    let error = apply_bsp_patch_file_native_from_path(&broken_path, &input_path, None)
        .expect_err("an undefined opcode must fail");
    assert!(
        matches!(&error, RomWeaverError::Validation(message)
            if message.contains("BSP patch execution failed: undefined opcode")),
        "unexpected error: {error:?}"
    );
}

#[test]
fn apply_native_surfaces_a_missing_input_file() {
    let temp = TestDir::new();
    let error = apply_bsp_patch_file_native(
        &[0x06, 0x00, 0x00, 0x00, 0x00],
        &temp.child("missing.bin"),
        None,
    )
    .expect_err("a missing input must fail");
    assert!(
        matches!(&error, RomWeaverError::Validation(message)
            if message.contains("failed to open BSP file buffer")),
        "unexpected error: {error:?}"
    );
}
