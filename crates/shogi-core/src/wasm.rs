//! Small JSON ABI. All calls run in one dedicated Web Worker. Input buffers are
//! consumed by shogi_call; the caller frees the returned output after decoding.
use crate::api::Api;
use std::cell::RefCell;
thread_local! { static API: RefCell<Api> = RefCell::new(Api::default()); }

#[no_mangle]
pub extern "C" fn shogi_alloc(len: u32) -> *mut u8 {
    Box::into_raw(vec![0u8; len as usize].into_boxed_slice()) as *mut u8
}

/// # Safety
/// ptr/len must describe a live allocation returned by shogi_alloc. Ownership
/// transfers to this function exactly once; arbitrary pointers are not accepted.
#[no_mangle]
pub unsafe extern "C" fn shogi_call(ptr: *mut u8, len: u32) -> u64 {
    let input = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len as usize));
    let output = API
        .with(|api| api.borrow_mut().json(&input))
        .into_boxed_slice();
    let length = output.len() as u64;
    let pointer = Box::into_raw(output) as *mut u8 as u64;
    (pointer << 32) | length
}

/// # Safety
/// ptr/len must describe an unfreed buffer returned by shogi_call (or alloc).
#[no_mangle]
pub unsafe extern "C" fn shogi_free(ptr: *mut u8, len: u32) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        ptr,
        len as usize,
    )));
}
