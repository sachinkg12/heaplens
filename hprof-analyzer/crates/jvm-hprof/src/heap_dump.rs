//! Sub records contained in [crate::HeapDumpSegment] records.
//!
//! # Performance
//!
//! Since sub records do not have a length prefix like records do, they cannot be almost entirely
//! lazily parsed -- the contents of the sub record must be parsed to know how long a sub record is.
//! That said, it is still reasonably fast at approximately 1GiB/s per core, and there is room to
//! make parsing lazier should the need arise.
use getset::{CopyGetters, Getters};

use crate::*;

mod primitive_array;

pub use primitive_array::PrimitiveArray;
pub use primitive_array::PrimitiveArrayType;

pub enum SubRecord<'a> {
    /// Doesn't seem to ever be written, but it's documented as existing
    GcRootUnknown(GcRootUnknown),
    GcRootThreadObj(GcRootThreadObj),
    GcRootJniGlobal(GcRootJniGlobal),
    GcRootJniLocalRef(GcRootJniLocalRef),
    GcRootJavaStackFrame(GcRootJavaStackFrame),
    /// Doesn't seem to ever be written, but it's documented as existing
    GcRootNativeStack(GcRootNativeStack),
    GcRootSystemClass(GcRootSystemClass),
    /// Doesn't seem to ever be written, but it's documented as existing
    GcRootThreadBlock(GcRootThreadBlock),
    GcRootBusyMonitor(GcRootBusyMonitor),
    // Android-specific GC root types (HPROF 1.0.3)
    GcRootInternedString(GcRootInternedString),
    GcRootFinalizing(GcRootFinalizing),
    GcRootDebugger(GcRootDebugger),
    GcRootReferenceCleanup(GcRootReferenceCleanup),
    GcRootVmInternal(GcRootVmInternal),
    GcRootJniMonitor(GcRootJniMonitor),
    GcRootUnreachable(GcRootUnreachable),
    // Android heap region metadata
    HeapDumpInfo(HeapDumpInfo),
    // Android primitive array with no data
    PrimitiveArrayNoData(PrimitiveArrayNoData),
    Class(Class<'a>),
    Instance(Instance<'a>),
    ObjectArray(ObjectArray<'a>),
    PrimitiveArray(PrimitiveArray<'a>),
}

impl<'a> fmt::Debug for SubRecord<'a> {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), Error> {
        write!(
            f,
            "{}",
            match self {
                SubRecord::GcRootUnknown(_) => "GcRootUnknown",
                SubRecord::GcRootThreadObj(_) => "GcRootThreadObj",
                SubRecord::GcRootJniGlobal(_) => "GcRootJniGlobal",
                SubRecord::GcRootJniLocalRef(_) => "GcRootJniLocalRef",
                SubRecord::GcRootJavaStackFrame(_) => "GcRootJavaStackFrame",
                SubRecord::GcRootNativeStack(_) => "GcRootNativeStack",
                SubRecord::GcRootSystemClass(_) => "GcRootSystemClass",
                SubRecord::GcRootThreadBlock(_) => "GcRootThreadBlock",
                SubRecord::GcRootBusyMonitor(_) => "GcRootBusyMonitor",
                SubRecord::GcRootInternedString(_) => "GcRootInternedString",
                SubRecord::GcRootFinalizing(_) => "GcRootFinalizing",
                SubRecord::GcRootDebugger(_) => "GcRootDebugger",
                SubRecord::GcRootReferenceCleanup(_) => "GcRootReferenceCleanup",
                SubRecord::GcRootVmInternal(_) => "GcRootVmInternal",
                SubRecord::GcRootJniMonitor(_) => "GcRootJniMonitor",
                SubRecord::GcRootUnreachable(_) => "GcRootUnreachable",
                SubRecord::HeapDumpInfo(_) => "HeapDumpInfo",
                SubRecord::PrimitiveArrayNoData(_) => "PrimitiveArrayNoData",
                SubRecord::Class(_) => "Class",
                SubRecord::Instance(_) => "Instance",
                SubRecord::ObjectArray(_) => "ObjectArray",
                SubRecord::PrimitiveArray(_) => "PrimitiveArray",
            }
        )
    }
}

impl<'a> SubRecord<'a> {
    pub(crate) fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], SubRecord> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L178
        let (input, tag_byte) = number::be_u8(input)?;

        // have to parse now since ClassObject, etc, have variable size

        let (input, variant) = match tag_byte {
            0xFF => GcRootUnknown::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootUnknown(r))),
            0x08 => GcRootThreadObj::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootThreadObj(r))),
            0x01 => GcRootJniGlobal::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootJniGlobal(r))),
            0x02 => GcRootJniLocalRef::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootJniLocalRef(r))),
            0x03 => GcRootJavaStackFrame::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootJavaStackFrame(r))),
            0x04 => GcRootNativeStack::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootNativeStack(r))),
            0x05 => GcRootSystemClass::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootSystemClass(r))),
            0x06 => GcRootThreadBlock::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootThreadBlock(r))),
            0x07 => GcRootBusyMonitor::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootBusyMonitor(r))),
            0x20 => Class::parse(input, id_size).map(|(input, r)| (input, SubRecord::Class(r))),
            0x21 => {
                Instance::parse(input, id_size).map(|(input, r)| (input, SubRecord::Instance(r)))
            }
            0x22 => ObjectArray::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::ObjectArray(r))),
            0x23 => PrimitiveArray::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::PrimitiveArray(r))),
            // Android-specific sub-record tags (HPROF 1.0.3)
            0x89 => GcRootInternedString::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootInternedString(r))),
            0x8a => GcRootFinalizing::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootFinalizing(r))),
            0x8b => GcRootDebugger::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootDebugger(r))),
            0x8c => GcRootReferenceCleanup::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootReferenceCleanup(r))),
            0x8d => GcRootVmInternal::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootVmInternal(r))),
            0x8e => GcRootJniMonitor::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootJniMonitor(r))),
            0x90 => GcRootUnreachable::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::GcRootUnreachable(r))),
            0xfe => HeapDumpInfo::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::HeapDumpInfo(r))),
            0xc3 => PrimitiveArrayNoData::parse(input, id_size)
                .map(|(input, r)| (input, SubRecord::PrimitiveArrayNoData(r))),
            _ => return Err(nom::Err::Failure((input, nom::error::ErrorKind::Tag))),
        }?;

        Ok((input, variant))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootUnknown {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootUnknown {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L180
        let (input, id) = Id::parse(input, id_size)?;

        Ok((input, GcRootUnknown { obj_id: id }))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootThreadObj {
    /// May be missing for a thread newly attached through JNI
    #[get_copy = "pub"]
    thread_obj_id: Option<Id>,
    #[get_copy = "pub"]
    thread_serial: Serial,
    #[get_copy = "pub"]
    stack_trace_serial: Serial,
}

impl GcRootThreadObj {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L184
        let (input, thread_obj_id) = parse_optional_id(input, id_size)?;
        let (input, thread_serial) = number::be_u32(input)?;
        let (input, stack_trace_serial) = number::be_u32(input)?;

        Ok((
            input,
            GcRootThreadObj {
                thread_obj_id,
                thread_serial: thread_serial.into(),
                stack_trace_serial: stack_trace_serial.into(),
            },
        ))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootJniGlobal {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    jni_global_ref_id: Id,
}

impl GcRootJniGlobal {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L191
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, jni_global_ref_id) = Id::parse(input, id_size)?;

        Ok((
            input,
            GcRootJniGlobal {
                obj_id,
                jni_global_ref_id,
            },
        ))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootJniLocalRef {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    thread_serial: Serial,
    #[get_copy = "pub"]
    frame_index: Option<u32>,
}

impl GcRootJniLocalRef {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L196
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, thread_serial) = number::be_u32(input)?;
        let (input, frame_index) = parse_optional_u32(input)?;

        Ok((
            input,
            GcRootJniLocalRef {
                obj_id,
                thread_serial: thread_serial.into(),
                frame_index,
            },
        ))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootJavaStackFrame {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    thread_serial: Serial,
    #[get_copy = "pub"]
    frame_index: Option<u32>,
}

impl GcRootJavaStackFrame {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L202
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, thread_serial) = number::be_u32(input)?;
        let (input, frame_index) = parse_optional_u32(input)?;

        Ok((
            input,
            GcRootJavaStackFrame {
                obj_id,
                thread_serial: thread_serial.into(),
                frame_index,
            },
        ))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootNativeStack {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    thread_serial: Serial,
}

impl GcRootNativeStack {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L208
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, thread_serial) = number::be_u32(input)?;

        Ok((
            input,
            GcRootNativeStack {
                obj_id,
                thread_serial: thread_serial.into(),
            },
        ))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootSystemClass {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootSystemClass {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L213
        let (input, obj_id) = Id::parse(input, id_size)?;

        Ok((input, GcRootSystemClass { obj_id }))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootThreadBlock {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    thread_serial: Serial,
}

impl GcRootThreadBlock {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L217
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, thread_serial) = number::be_u32(input)?;

        Ok((
            input,
            GcRootThreadBlock {
                obj_id,
                thread_serial: thread_serial.into(),
            },
        ))
    }
}

#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootBusyMonitor {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootBusyMonitor {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L222
        let (input, obj_id) = Id::parse(input, id_size)?;

        Ok((input, GcRootBusyMonitor { obj_id }))
    }
}

// --- Android-specific sub-record types (HPROF 1.0.3) ---

/// Android GC root: interned string
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootInternedString {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootInternedString {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, obj_id) = Id::parse(input, id_size)?;
        Ok((input, GcRootInternedString { obj_id }))
    }
}

/// Android GC root: finalizing object
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootFinalizing {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootFinalizing {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, obj_id) = Id::parse(input, id_size)?;
        Ok((input, GcRootFinalizing { obj_id }))
    }
}

/// Android GC root: debugger reference
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootDebugger {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootDebugger {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, obj_id) = Id::parse(input, id_size)?;
        Ok((input, GcRootDebugger { obj_id }))
    }
}

/// Android GC root: reference cleanup
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootReferenceCleanup {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootReferenceCleanup {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, obj_id) = Id::parse(input, id_size)?;
        Ok((input, GcRootReferenceCleanup { obj_id }))
    }
}

/// Android GC root: VM internal reference
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootVmInternal {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootVmInternal {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, obj_id) = Id::parse(input, id_size)?;
        Ok((input, GcRootVmInternal { obj_id }))
    }
}

/// Android GC root: JNI monitor
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootJniMonitor {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    thread_serial: u32,
    #[get_copy = "pub"]
    stack_depth: u32,
}

impl GcRootJniMonitor {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, thread_serial) = number::be_u32(input)?;
        let (input, stack_depth) = number::be_u32(input)?;
        Ok((input, GcRootJniMonitor { obj_id, thread_serial, stack_depth }))
    }
}

/// Android GC root: unreachable object
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct GcRootUnreachable {
    #[get_copy = "pub"]
    obj_id: Id,
}

impl GcRootUnreachable {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, obj_id) = Id::parse(input, id_size)?;
        Ok((input, GcRootUnreachable { obj_id }))
    }
}

/// Android heap dump info — marks the start of a heap region (app, zygote, image)
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct HeapDumpInfo {
    #[get_copy = "pub"]
    heap_type: u32,
    #[get_copy = "pub"]
    heap_name_id: Id,
}

impl HeapDumpInfo {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, heap_type) = number::be_u32(input)?;
        let (input, heap_name_id) = Id::parse(input, id_size)?;
        Ok((input, HeapDumpInfo { heap_type, heap_name_id }))
    }
}

/// Android primitive array with no data (array structure exists but data stripped)
#[derive(CopyGetters, Copy, Clone, Debug)]
pub struct PrimitiveArrayNoData {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    stack_trace_serial: Serial,
    #[get_copy = "pub"]
    num_elements: u32,
    #[get_copy = "pub"]
    primitive_type: PrimitiveArrayType,
}

impl PrimitiveArrayNoData {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, stack_trace_serial) = number::be_u32(input)?;
        let (input, num_elements) = number::be_u32(input)?;
        let (input, type_byte) = number::be_u8(input)?;
        let primitive_type = match PrimitiveArrayType::from_type_code(type_byte) {
            Some(t) => t,
            None => return Err(nom::Err::Failure((input, nom::error::ErrorKind::Tag))),
        };
        Ok((input, PrimitiveArrayNoData {
            obj_id,
            stack_trace_serial: stack_trace_serial.into(),
            num_elements,
            primitive_type,
        }))
    }
}

/// Analogous to a `java.lang.Class` object.
///
/// A notable absence from this is the class name, which is available via [crate::LoadClass]
/// records.
#[derive(CopyGetters)]
pub struct Class<'a> {
    id_size: IdSize,
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    stack_trace_serial: Serial,
    /// `None` when there is no superclass, e.g. for `java.lang.Object`.
    #[get_copy = "pub"]
    super_class_obj_id: Option<Id>,
    #[get_copy = "pub"]
    class_loader_obj_id: Option<Id>,
    #[get_copy = "pub"]
    signers_obj_id: Option<Id>,
    // TODO optional
    #[get_copy = "pub"]
    protection_domain_obj_id: Option<Id>,
    #[get_copy = "pub"]
    instance_size_bytes: u32,
    num_static_fields: u16,
    static_fields: &'a [u8],
    num_instance_fields: u16,
    instance_fields: &'a [u8],
}

impl<'a> Class<'a> {
    /// Iterate over [StaticFieldEntry] data.
    pub fn static_fields(&self) -> StaticFieldEntries {
        StaticFieldEntries {
            iter: ParsingIterator::new_stateless_id_size(
                self.id_size,
                self.static_fields,
                self.num_static_fields as u32,
            ),
        }
    }

    /// Iterate over [FieldDescriptor] data.
    ///
    /// Contains only the instance fields defined in this class, not in superclasses.
    ///
    /// An object's fields are serialized with the concrete type's fields first, then that class's
    /// superclass, and so forth, up to the root of the hierarchy.
    pub fn instance_field_descriptors(&self) -> FieldDescriptors {
        FieldDescriptors {
            iter: ParsingIterator::new_stateless_id_size(
                self.id_size,
                self.instance_fields,
                self.num_instance_fields as u32,
            ),
        }
    }

    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Class> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L226
        // dump_class_and_array_classes https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L995
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, stack_trace_serial) = number::be_u32(input)?;
        let (input, super_class_obj_id) = parse_optional_id(input, id_size)?;
        let (input, class_loader_obj_id) = parse_optional_id(input, id_size)?;
        let (input, signers_obj_id) = parse_optional_id(input, id_size)?;
        let (input, protection_domain_obj_id) = parse_optional_id(input, id_size)?;
        // 2x Id reserved
        let (input, _) = Id::parse(input, id_size)?;
        let (input, _) = Id::parse(input, id_size)?;
        let (input, instance_size_bytes) = number::be_u32(input)?;
        let (input, constant_pool_len) = number::be_u16(input)?;
        // constant pool len always 0 as per
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L1031
        // TODO parse failure
        assert_eq!(0, constant_pool_len);

        let (input, num_static_fields) = number::be_u16(input)?;

        // since we get a _number of fields_ not a length in bytes, we have to parse now :(
        // Fortunately, the number of classes << number of objects, so we only will have to do this
        // tens of thousands of times, not billions.
        // To save memory, we parse now to get the length, then just keep a slice and parse on
        // demand later.

        let input_before_static_fields = input;
        // need to keep track of input outside the loop scope
        let mut input_after_static_fields = input;
        for _ in 0..num_static_fields {
            let (input, _) = StaticFieldEntry::parse(input_after_static_fields, id_size)?;
            input_after_static_fields = input;
        }

        let static_fields_byte_len =
            input_before_static_fields.len() - input_after_static_fields.len();
        let (_input, static_fields) = bytes::take(static_fields_byte_len)(input)?;

        // instance field descriptors https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L964
        let (input, num_instance_fields) = number::be_u16(input_after_static_fields)?;

        // descriptors are a (name id, tag) pair, so we don't have to parse now
        let instance_fields_byte_len = num_instance_fields as usize * (id_size.size_in_bytes() + 1);

        let (input, instance_fields) = bytes::take(instance_fields_byte_len)(input)?;

        Ok((
            input,
            Class {
                id_size,
                obj_id,
                stack_trace_serial: stack_trace_serial.into(),
                super_class_obj_id,
                class_loader_obj_id,
                signers_obj_id,
                protection_domain_obj_id,
                instance_size_bytes,
                num_static_fields,
                static_fields,
                num_instance_fields,
                instance_fields,
            },
        ))
    }
}

/// Iterator over [StaticFieldEntry] for a [Class].
pub struct StaticFieldEntries<'a> {
    iter: ParsingIterator<'a, StaticFieldEntry, IdSizeParserWrapper<StaticFieldEntry>>,
}

impl<'a> Iterator for StaticFieldEntries<'a> {
    type Item = ParseResult<'a, StaticFieldEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        self.iter.next()
    }
}

/// Iterator over [FieldDescriptor]s.
pub struct FieldDescriptors<'a> {
    iter: ParsingIterator<'a, FieldDescriptor, IdSizeParserWrapper<FieldDescriptor>>,
}

impl<'a> Iterator for FieldDescriptors<'a> {
    type Item = ParseResult<'a, FieldDescriptor>;

    fn next(&mut self) -> Option<Self::Item> {
        self.iter.next()
    }
}

/// An instance of a reference type (i.e. not a primitive).
#[derive(CopyGetters, Getters)]
pub struct Instance<'a> {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    stack_trace_serial: Serial,
    #[get_copy = "pub"]
    class_obj_id: Id,
    /// Instance field values, root class's fields last.
    #[get = "pub"]
    fields: &'a [u8],
}

impl<'a> Instance<'a> {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Instance> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L262
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, stack_trace_serial) = number::be_u32(input)?;
        let (input, class_obj_id) = Id::parse(input, id_size)?;
        let (input, fields_byte_len) = number::be_u32(input)?;
        let (input, fields) = bytes::take(fields_byte_len)(input)?;

        Ok((
            input,
            Instance {
                obj_id,
                stack_trace_serial: stack_trace_serial.into(),
                class_obj_id,
                fields,
            },
        ))
    }
}

/// An array of anything other than a primitive type.
#[derive(CopyGetters)]
pub struct ObjectArray<'a> {
    #[get_copy = "pub"]
    obj_id: Id,
    #[get_copy = "pub"]
    stack_trace_serial: Serial,
    /// The obj id of the class that this is an array of
    #[get_copy = "pub"]
    array_class_obj_id: Id,
    num_elements: u32,
    contents: &'a [u8],
}

impl<'a> ObjectArray<'a> {
    /// Returns the number of elements in this object array, read directly
    /// from the HPROF record header (O(1), no iteration required).
    pub fn num_elements(&self) -> u32 {
        self.num_elements
    }

    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], ObjectArray> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L271
        let (input, obj_id) = Id::parse(input, id_size)?;
        let (input, stack_trace_serial) = number::be_u32(input)?;
        let (input, num_elements) = number::be_u32(input)?;
        let (input, array_class_id) = Id::parse(input, id_size)?;

        let id_bytes_len = num_elements as usize * id_size.size_in_bytes();

        let (input, contents) = bytes::take(id_bytes_len)(input)?;

        Ok((
            input,
            ObjectArray {
                obj_id,
                stack_trace_serial: stack_trace_serial.into(),
                array_class_obj_id: array_class_id,
                num_elements,
                contents,
            },
        ))
    }

    /// The obj ids of the objects in the array
    pub fn elements(&self, id_size: IdSize) -> NullableIds {
        NullableIds {
            iter: ParsingIterator::new_stateless_id_size(id_size, self.contents, self.num_elements),
        }
    }
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
enum ConstantPoolEntry {}

/// The field type and value for a static field in a [Class].
#[derive(CopyGetters, Clone, Copy, Debug)]
pub struct StaticFieldEntry {
    #[get_copy = "pub"]
    name_id: Id,
    #[get_copy = "pub"]
    field_type: FieldType,
    #[get_copy = "pub"]
    value: FieldValue,
}

impl StatelessParserWithId for StaticFieldEntry {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, name_id) = Id::parse(input, id_size)?;

        let (input, field_type) = FieldType::parse(input)?;
        let (input, value) = field_type.parse_value(input, id_size)?;

        Ok((
            input,
            StaticFieldEntry {
                name_id,
                field_type,
                value,
            },
        ))
    }
}

#[derive(Clone, Copy, Debug)]
pub enum FieldValue {
    ObjectId(Option<Id>),
    Boolean(bool),
    Char(u16),
    Float(f32),
    Double(f64),
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
}

/// The name and type of an instance field.
#[derive(CopyGetters, Clone, Copy, Debug)]
pub struct FieldDescriptor {
    #[get_copy = "pub"]
    name_id: Id,
    #[get_copy = "pub"]
    field_type: FieldType,
}

impl StatelessParserWithId for FieldDescriptor {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, name_id) = Id::parse(input, id_size)?;

        let (input, field_type) = FieldType::parse(input)?;

        Ok((
            input,
            FieldDescriptor {
                name_id,
                field_type,
            },
        ))
    }
}

#[derive(Clone, Copy, Debug)]
pub enum FieldType {
    ObjectId,
    Boolean,
    Char,
    Float,
    Double,
    Byte,
    Short,
    Int,
    Long,
}

impl FieldType {
    fn parse(input: &[u8]) -> nom::IResult<&[u8], Self> {
        let (input, type_byte) = number::be_u8(input)?;

        // tags https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L709
        let field_type = match type_byte {
            // 0x01 is HPROF_ARRAY_OBJECT, which seems to never be used
            0x02 => FieldType::ObjectId,
            0x04 => FieldType::Boolean,
            0x05 => FieldType::Char,
            0x06 => FieldType::Float,
            0x07 => FieldType::Double,
            0x08 => FieldType::Byte,
            0x09 => FieldType::Short,
            0x0A => FieldType::Int,
            0x0B => FieldType::Long,
            _ => return Err(nom::Err::Failure((input, nom::error::ErrorKind::Tag))),
        };

        Ok((input, field_type))
    }

    /// Returns the corresponding `FieldValue` variant
    pub fn parse_value<'a>(
        &self,
        input: &'a [u8],
        id_size: IdSize,
    ) -> nom::IResult<&'a [u8], FieldValue> {
        // dump_field_value https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L769
        match self {
            FieldType::ObjectId => parse_optional_id(input, id_size)
                .map(|(input, id)| (input, FieldValue::ObjectId(id))),
            FieldType::Boolean => {
                bool::parse(input).map(|(input, b)| (input, FieldValue::Boolean(b)))
            }
            FieldType::Char => u16::parse(input).map(|(input, c)| (input, FieldValue::Char(c))),
            FieldType::Float => f32::parse(input).map(|(input, f)| (input, FieldValue::Float(f))),
            FieldType::Double => f64::parse(input).map(|(input, f)| (input, FieldValue::Double(f))),
            FieldType::Byte => i8::parse(input).map(|(input, b)| (input, FieldValue::Byte(b))),
            FieldType::Short => i16::parse(input).map(|(input, s)| (input, FieldValue::Short(s))),
            FieldType::Int => i32::parse(input).map(|(input, i)| (input, FieldValue::Int(i))),
            FieldType::Long => i64::parse(input).map(|(input, l)| (input, FieldValue::Long(l))),
        }
    }

    pub fn java_type_name(&self) -> &'static str {
        match self {
            FieldType::ObjectId => "Object",
            FieldType::Boolean => "boolean",
            FieldType::Char => "char",
            FieldType::Float => "float",
            FieldType::Double => "double",
            FieldType::Byte => "byte",
            FieldType::Short => "short",
            FieldType::Int => "int",
            FieldType::Long => "long",
        }
    }
}

fn parse_optional_id(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Option<Id>> {
    Id::parse(input, id_size).map(|(input, id)| {
        if id.id == 0 {
            (input, None)
        } else {
            (input, Some(id))
        }
    })
}

fn parse_optional_u32(input: &[u8]) -> nom::IResult<&[u8], Option<u32>> {
    number::be_u32(input).map(|(input, index)| {
        if index == u32::max_value() {
            (input, None)
        } else {
            (input, Some(index))
        }
    })
}

/// Iterator over object ids that may be null, represented as `Option<Id>`.
pub struct NullableIds<'a> {
    iter: ParsingIterator<'a, Option<Id>, IdSizeParserWrapper<Option<Id>>>,
}

impl<'a> Iterator for NullableIds<'a> {
    type Item = ParseResult<'a, Option<Id>>;

    fn next(&mut self) -> Option<Self::Item> {
        self.iter.next()
    }
}

impl StatelessParserWithId for Option<Id> {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        parse_optional_id(input, id_size)
    }
}
