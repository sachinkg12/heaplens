//! A library for parsing hprof files.
//!
//! See [parse_hprof] to get started, or see the examples in the repo.
use getset::CopyGetters;
use nom::bytes::complete as bytes;
use nom::number::complete as number;
use std::cmp::Ordering;
use std::fmt::{Error, Formatter};
use std::{cmp, fmt};
use strum_macros;
use strum_macros::EnumIter;

pub mod heap_dump;
mod parsing_iterator;

use parsing_iterator::*;

/// Ids are used to identify many things in an hprof file: objects, classes, utf8 blobs, etc.
///
/// The on-disk representation of an Id depends on the relevant [IdSize].
#[derive(CopyGetters, Copy, Clone, Debug, Eq, Hash, PartialEq)]
pub struct Id {
    // inflate 4-byte ids to 8-byte since if we have a small 32-bit heap, no worries about memory anyway
    #[get_copy = "pub"]
    id: u64,
}

impl From<u64> for Id {
    fn from(id: u64) -> Id {
        Id { id }
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.id)
    }
}

impl fmt::UpperHex for Id {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        fmt::UpperHex::fmt(&self.id, f)
    }
}

/// An alternate means of identification used in parallel with [Id].
///
/// [LoadClass], for instance, has both a `class_obj_id` and a `serial`. In certain cases you might
/// need to use one or the other. If you were processing [StackFrame] records and wanted to print
/// human readable class names (which are available in [LoadClass], [StackFrame] uses
/// `class_serial`, whereas if you were inspecting a class's fields via [crate::heap_dump::Class],
/// that only has the class's `obj_id` available.
#[derive(CopyGetters, Copy, Clone, Debug, Eq, Hash, PartialEq)]
pub struct Serial {
    /// The plain serial number.
    #[get_copy = "pub"]
    num: u32,
}

impl From<u32> for Serial {
    fn from(num: u32) -> Self {
        Serial { num }
    }
}

impl fmt::Display for Serial {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.num)
    }
}

impl fmt::UpperHex for Serial {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        fmt::UpperHex::fmt(&self.num, f)
    }
}

impl StatelessParserWithId for Id {
    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Self> {
        let (input, id) = match id_size {
            IdSize::U32 => number::be_u32(input).map(|(i, id)| (i, id as u64))?,
            IdSize::U64 => number::be_u64(input)?,
        };

        Ok((input, Id::from(id)))
    }
}

/// Hprof ids can be 32 or 64 bit, depending on the system and JVM that the hprof was captured on.
///
/// This controls how ids are parsed, and can generally be otherwise ignored.
#[derive(Debug, Clone, Copy)]
pub enum IdSize {
    U32,
    U64,
}

impl IdSize {
    fn size_in_bytes(&self) -> usize {
        match self {
            IdSize::U32 => 4,
            IdSize::U64 => 8,
        }
    }
}

/// The top level of data loaded from an .hprof file.
// https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp
#[derive(CopyGetters)]
pub struct Hprof<'a> {
    #[get_copy = "pub"]
    header: Header<'a>,
    records: &'a [u8],
}

impl<'a> Hprof<'a> {
    /// Iterate over the [Record] data in the hprof.
    ///
    /// Iteration is cheap, as each [Record] defers parsing the bulk of its data until later.
    pub fn records_iter(&self) -> Records<'a> {
        Records {
            remaining: self.records,
            id_size: self.header.id_size,
        }
    }
}

/// Entry point for parsing.
///
/// This is intended to be used with a memory mapped hprof file, or, for small heap dumps that can
/// fit comfortably in memory, just an in-memory buffer.
pub fn parse_hprof(input: &[u8]) -> ParseResult<Hprof> {
    let (input, header) = Header::parse(input)?;

    Ok(Hprof {
        header,
        records: input,
    })
}

/// Basic metadata about the hprof
#[derive(CopyGetters, Copy, Clone)]
pub struct Header<'a> {
    label: &'a [u8],
    #[get_copy = "pub"]
    id_size: IdSize,
    /// The timestamp for the hprof as the number of millis since epoch
    #[get_copy = "pub"]
    timestamp_millis: u64,
}

impl<'a> Header<'a> {
    pub fn label(&self) -> Result<&'a str, std::str::Utf8Error> {
        std::str::from_utf8(self.label)
    }

    fn parse(input: &[u8]) -> nom::IResult<&[u8], Header> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L63
        let (input, label) = bytes::take_until(&b"\0"[..])(input)?;
        let (input, _) = bytes::take_while_m_n(1, 1, |b| b == 0)(input)?;

        // TODO confirm endianness
        let (input, id_size_num) = number::be_u32(input)?;
        let (input, epoch_hi) = number::be_u32(input)?;
        let (input, epoch_lo) = number::be_u32(input)?;

        let epoch_timestamp = ((epoch_hi as u64) << 32) + (epoch_lo as u64);

        let id_size = match id_size_num {
            4 => IdSize::U32,
            8 => IdSize::U64,
            _ => return Err(nom::Err::Failure((input, nom::error::ErrorKind::Tag))),
        };

        Ok((
            input,
            Header {
                label,
                id_size,
                timestamp_millis: epoch_timestamp,
            },
        ))
    }
}

impl<'a> fmt::Debug for Header<'a> {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), Error> {
        f.debug_struct("Header")
            .field("label", &self.label())
            .field("timestamp_millis", &self.timestamp_millis())
            .field("id_size", &self.id_size())
            .finish()
    }
}

/// Iterator over the [Record] data in an hprof.
pub struct Records<'a> {
    remaining: &'a [u8],
    id_size: IdSize,
}

impl<'a> Iterator for Records<'a> {
    type Item = ParseResult<'a, Record<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }

        let res = Record::parse(self.remaining, self.id_size);
        match res {
            Ok((input, record)) => {
                self.remaining = input;
                Some(Ok(record))
            }
            Err(e) => Some(Err(e)),
        }
    }
}

/// The next level down from the [Hprof] in the hierarchy of data.
///
/// See [RecordTag] for the different types of data that can be in a Record.
///
/// # Performance
///
/// Records are generic and lightweight: the parsing done to get a Record is just loading a couple
/// of bytes to get the tag and timestamp, and a slice that contains the "body" of the record, so
/// iterating across all Records without inspecting the body of each one is cheap. Even huge heap
/// dumps might have only tens of thousands of Records.
///
/// Since iterating records is very fast but parsing the contents may not be (e.g. a sequence of
/// 2GiB [HeapDumpSegment] records), records are especially amenable to parallel processing, e.g.
/// with rayon's `par_bridge()`.
#[derive(CopyGetters, Copy, Clone)]
pub struct Record<'a> {
    /// The tag, which determines which of the `as_*` methods it is suitable to call.
    #[get_copy = "pub"]
    tag: RecordTag,
    /// Microseconds since the timestamp in the header
    #[get_copy = "pub"]
    micros_since_header_ts: u32,
    id_size: IdSize,
    body: &'a [u8],
}

impl<'a> Record<'a> {
    /// Returns `Some` if the tag is [RecordTag::Utf8] and `None` otherwise.
    pub fn as_utf_8(&self) -> Option<ParseResult<Utf8<'a>>> {
        match self.tag {
            RecordTag::Utf8 => Some(Utf8::parse(self.body, self.id_size)),
            _ => None,
        }
    }

    /// Returns `Some` if the tag is [RecordTag::LoadClass] and `None` otherwise.
    pub fn as_load_class(&self) -> Option<ParseResult<LoadClass>> {
        match self.tag {
            RecordTag::LoadClass => Some(LoadClass::parse(self.body, self.id_size)),
            _ => None,
        }
    }

    /// Returns `Some` if the tag is [RecordTag::StackFrame] and `None` otherwise.
    pub fn as_stack_frame(&self) -> Option<ParseResult<StackFrame>> {
        match self.tag {
            RecordTag::StackFrame => Some(StackFrame::parse(self.body, self.id_size)),
            _ => None,
        }
    }

    /// Returns `Some` if the tag is [RecordTag::StackTrace] and `None` otherwise.
    pub fn as_stack_trace(&self) -> Option<ParseResult<StackTrace<'a>>> {
        match self.tag {
            RecordTag::StackTrace => Some(StackTrace::parse(self.body, self.id_size)),
            _ => None,
        }
    }

    /// Returns `Some` if the tag is [RecordTag::HeapDump] or [RecordTag::HeapDumpSegment] and
    /// `None` otherwise.
    pub fn as_heap_dump_segment(&self) -> Option<ParseResult<HeapDumpSegment<'a>>> {
        match self.tag {
            RecordTag::HeapDump | RecordTag::HeapDumpSegment => {
                Some(HeapDumpSegment::parse(self.body, self.id_size))
            }
            _ => None,
        }
    }

    fn parse(input: &[u8], id_size: IdSize) -> nom::IResult<&[u8], Record> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L76
        let (input, tag_byte) = bytes::take(1_usize)(input)?;

        let tag = match tag_byte[0] {
            0x01 => RecordTag::Utf8,
            0x02 => RecordTag::LoadClass,
            0x03 => RecordTag::UnloadClass,
            0x04 => RecordTag::StackFrame,
            0x05 => RecordTag::StackTrace,
            0x06 => RecordTag::AllocSites,
            0x07 => RecordTag::HeapSummary,
            0x0A => RecordTag::StartThread,
            0x0B => RecordTag::EndThread,
            0x0C => RecordTag::HeapDump,
            0x0D => RecordTag::CpuSamples,
            0x0E => RecordTag::ControlSettings,
            0x1C => RecordTag::HeapDumpSegment,
            0x2C => RecordTag::HeapDumpEnd,
            _ => RecordTag::Unknown(tag_byte[0]),
        };

        let (input, micros) = number::be_u32(input)?;
        let (input, len) = number::be_u32(input)?;
        let (input, body) = bytes::take(len)(input)?;

        Ok((
            input,
            Record {
                tag,
                micros_since_header_ts: micros,
                id_size,
                body,
            },
        ))
    }
}

/// Indicates what type of data is contained in a particular [Record].
///
/// Each variant has a matching struct. Calling [Record::as_utf_8] on a `Record` with tag
/// `RecordTag::Utf8`, for instance, will produce a [Utf8] struct.
// Since this enum has no data, add EnumIter to allow enumerating across the variants
#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Hash)]
pub enum RecordTag {
    /// See [Utf8]
    Utf8,
    /// See [LoadClass]
    LoadClass,
    /// Unused?
    UnloadClass,
    /// See [StackFrame]
    StackFrame,
    /// See [StackTrace]
    StackTrace,
    /// Unused?
    AllocSites,
    /// Unused?
    StartThread,
    /// Unused?
    EndThread,
    /// Unused?
    HeapSummary,
    /// See [HeapDumpSegment]
    HeapDump,
    /// Unused?
    CpuSamples,
    /// Unused?
    ControlSettings,
    /// See [HeapDumpSegment]
    HeapDumpSegment,
    /// Denotes the end of a heap dump
    HeapDumpEnd,
    /// Unknown record tag — top-level records have a length prefix so can be safely skipped
    Unknown(u8),
}

impl RecordTag {
    fn tag_byte(&self) -> u8 {
        match self {
            RecordTag::Utf8 => 0x01,
            RecordTag::LoadClass => 0x02,
            RecordTag::UnloadClass => 0x03,
            RecordTag::StackFrame => 0x04,
            RecordTag::StackTrace => 0x05,
            RecordTag::AllocSites => 0x06,
            RecordTag::HeapSummary => 0x07,
            RecordTag::StartThread => 0x0A,
            RecordTag::EndThread => 0x0B,
            RecordTag::HeapDump => 0x0C,
            RecordTag::CpuSamples => 0x0D,
            RecordTag::ControlSettings => 0x0E,
            RecordTag::HeapDumpSegment => 0x1C,
            RecordTag::HeapDumpEnd => 0x2C,
            RecordTag::Unknown(b) => *b,
        }
    }
}

impl cmp::Ord for RecordTag {
    fn cmp(&self, other: &Self) -> Ordering {
        self.tag_byte().cmp(&other.tag_byte())
    }
}

/// Contents of a [Record] with tag [RecordTag::Utf8].
#[derive(CopyGetters, Copy, Clone)]
pub struct Utf8<'a> {
    #[get_copy = "pub"]
    name_id: Id,
    #[get_copy = "pub"]
    text: &'a [u8],
}

impl<'a> Utf8<'a> {
    fn parse(input: &[u8], id_size: IdSize) -> ParseResult<Utf8> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L88
        let (input, id) = Id::parse(input, id_size)?;

        Ok(Utf8 {
            name_id: id,
            text: input,
        })
    }

    /// Note that in practice, there are nonzero Utf8 records with invalid UTF-8 bytes.
    pub fn text_as_str(&self) -> Result<&'a str, std::str::Utf8Error> {
        std::str::from_utf8(self.text)
    }
}

/// Contents of a [Record] with tag [RecordTag::LoadClass].
#[derive(CopyGetters, Copy, Clone)]
pub struct LoadClass {
    #[get_copy = "pub"]
    class_serial: Serial,
    #[get_copy = "pub"]
    class_obj_id: Id,
    #[get_copy = "pub"]
    stack_trace_serial: Serial,
    #[get_copy = "pub"]
    class_name_id: Id,
}

impl LoadClass {
    fn parse(input: &[u8], id_size: IdSize) -> ParseResult<LoadClass> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L93
        let (input, class_serial) = number::be_u32(input)?;
        let (input, class_obj_id) = Id::parse(input, id_size)?;
        let (input, stack_trace_serial) = number::be_u32(input)?;
        let (_input, class_name_id) = Id::parse(input, id_size)?;

        Ok(LoadClass {
            class_serial: class_serial.into(),
            class_obj_id,
            stack_trace_serial: stack_trace_serial.into(),
            class_name_id,
        })
    }
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
struct UnloadClass {
    class_serial: Serial,
}

/// Contents of a [Record] with tag [RecordTag::StackFrame].
#[derive(CopyGetters, Clone)]
pub struct StackFrame {
    #[get_copy = "pub"]
    id: Id,
    #[get_copy = "pub"]
    method_name_id: Id,
    #[get_copy = "pub"]
    method_signature_id: Id,
    #[get_copy = "pub"]
    source_file_name_id: Id,
    #[get_copy = "pub"]
    class_serial: Serial,
    #[get_copy = "pub"]
    line_num: LineNum,
}

impl StackFrame {
    fn parse(input: &[u8], id_size: IdSize) -> ParseResult<Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L104
        let (input, id) = Id::parse(input, id_size)?;
        let (input, method_name_id) = Id::parse(input, id_size)?;
        let (input, method_signature_id) = Id::parse(input, id_size)?;
        // TODO Option?
        let (input, source_file_name_id) = Id::parse(input, id_size)?;
        let (input, class_serial) = number::be_u32(input)?;
        let (_input, line_num) = LineNum::parse(input)?;

        Ok(StackFrame {
            id,
            method_name_id,
            method_signature_id,
            source_file_name_id,
            class_serial: class_serial.into(),
            line_num,
        })
    }
}

/// Contents of a [Record] with tag [RecordTag::StackTrace].
#[derive(CopyGetters, Clone)]
pub struct StackTrace<'a> {
    id_size: IdSize,
    #[get_copy = "pub"]
    stack_trace_serial: Serial,
    #[get_copy = "pub"]
    thread_serial: Serial,
    num_frame_ids: u32,
    frame_ids: &'a [u8],
}

impl<'a> StackTrace<'a> {
    fn parse(input: &[u8], id_size: crate::IdSize) -> ParseResult<StackTrace> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L116
        let (input, stack_trace_serial) = number::be_u32(input)?;
        let (input, thread_serial) = number::be_u32(input)?;
        let (input, num_frame_ids) = number::be_u32(input)?;

        Ok(StackTrace {
            id_size,
            stack_trace_serial: stack_trace_serial.into(),
            thread_serial: thread_serial.into(),
            num_frame_ids,
            frame_ids: input,
        })
    }

    pub fn frame_ids(&self) -> Ids {
        Ids {
            iter: ParsingIterator::new_stateless_id_size(
                self.id_size,
                self.frame_ids,
                self.num_frame_ids,
            ),
        }
    }
}

/// Heap allocation sites, obtained after GC
// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
struct AllocSites {
    flags: AllocSitesFlags,
    cutoff_ratio: u32,
    total_live_bytes: u32,
    total_live_instances: u32,
    total_bytes_allocated: u64,
    total_instances_allocated: u64,
    // num_sites: u4
    // TODO iterator over following AllocSite instances
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
struct StartThread {
    thread_serial: Serial,
    thread_id: Id,
    stack_trace_serial: Serial,
    thread_name_id: Id,
    thread_group_name_id: Id,
    thread_group_parent_name_id: Id,
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
struct EndThread {
    thread_serial: Serial,
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
struct HeapSummary {
    total_live_bytes: u32,
}

/// Contents of a [Record] with tag [RecordTag::HeapDump] or [RecordTag::HeapDumpSegment].
///
/// Contains many [heap_dump::SubRecord]s.
///
/// See the [heap_dump] module.
pub struct HeapDumpSegment<'a> {
    id_size: IdSize,
    records: &'a [u8],
}

impl<'a> HeapDumpSegment<'a> {
    fn parse(input: &[u8], id_size: IdSize) -> ParseResult<HeapDumpSegment> {
        Ok(HeapDumpSegment {
            id_size,
            records: input,
        })
    }

    /// Iterate over the [heap_dump::SubRecord]s in this [Record].
    pub fn sub_records(&self) -> SubRecords<'a> {
        SubRecords {
            id_size: self.id_size,
            remaining: self.records,
        }
    }
}

/// Iterator over [heap_dump::SubRecord] data.
#[derive(Clone)]
pub struct SubRecords<'a> {
    id_size: IdSize,
    remaining: &'a [u8],
}

impl<'a> Iterator for SubRecords<'a> {
    type Item = ParseResult<'a, heap_dump::SubRecord<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining.is_empty() {
            return None;
        }

        let res = heap_dump::SubRecord::parse(self.remaining, self.id_size);
        match res {
            Ok((input, record)) => {
                self.remaining = input;
                Some(Ok(record))
            }
            Err(e) => Some(Err(e)),
        }
    }
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
struct CpuSamples {
    num_samples: u32,
    num_traces: u32,
    // TODO iterator over samples
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
struct ControlSettings {
    bits: u32,
    stack_trace_depth: u16,
}

/// A line referenced from a stack frame.
#[derive(Copy, Clone, Debug)]
pub enum LineNum {
    /// A line in a source file
    Normal(u32),
    Unknown,
    CompiledMethod,
    NativeMethod,
}

impl LineNum {
    fn parse(input: &[u8]) -> nom::IResult<&[u8], Self> {
        // https://github.com/openjdk/jdk/blob/08822b4e0526fe001c39fe08e241b849eddf481d/src/hotspot/share/services/heapDumper.cpp#L111
        let (input, num) = number::be_i32(input)?;

        Ok((
            input,
            match num {
                num if num > 0 => LineNum::Normal(num as u32),
                -1 => LineNum::Unknown,
                -2 => LineNum::CompiledMethod,
                -3 => LineNum::NativeMethod,
                _ => LineNum::Unknown,
            },
        ))
    }
}

impl fmt::Display for LineNum {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), Error> {
        match self {
            LineNum::Normal(n) => write!(f, "{}", n),
            LineNum::Unknown => write!(f, "Unknown"),
            LineNum::CompiledMethod => write!(f, "CompiledMethod"),
            LineNum::NativeMethod => write!(f, "NativeMethod"),
        }
    }
}

#[derive(Copy, Clone, Debug)]
struct AllocSitesFlags {
    bits: u16,
}

impl AllocSitesFlags {
    // TODO referenced in heapDumper.cpp, but not actually written?
    #[allow(unused)]
    fn mode(&self) -> AllocSitesFlagsMode {
        // TODO naming, correctness?
        if self.bits & 0x001 > 0 {
            AllocSitesFlagsMode::Incremental
        } else {
            AllocSitesFlagsMode::Complete
        }
    }

    // TODO referenced in heapDumper.cpp, but not actually written?
    #[allow(unused)]
    fn sorting(&self) -> AllocSitesFlagsSorting {
        // TODO
        if self.bits & 0x002 > 0 {
            AllocSitesFlagsSorting::Allocation
        } else {
            AllocSitesFlagsSorting::Live
        }
    }

    // TODO referenced in heapDumper.cpp, but not actually written?
    #[allow(unused)]
    fn force_gc(&self) -> bool {
        self.bits & 0x0004 > 0
    }
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
enum AllocSitesFlagsMode {
    Incremental,
    Complete,
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
enum AllocSitesFlagsSorting {
    Allocation,
    Live,
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
enum ObjOrArrayType {
    Object,
    ObjectArray,
    BooleanArray,
    CharArray,
    FloatArray,
    DoubleArray,
    ByteArray,
    ShortArray,
    IntArray,
    LongArray,
}

impl ObjOrArrayType {
    // TODO referenced in heapDumper.cpp, but not actually written?
    #[allow(unused)]
    fn from_num(num: u8) -> ObjOrArrayType {
        match num {
            0 => ObjOrArrayType::Object,
            2 => ObjOrArrayType::ObjectArray,
            4 => ObjOrArrayType::BooleanArray,
            5 => ObjOrArrayType::CharArray,
            6 => ObjOrArrayType::FloatArray,
            7 => ObjOrArrayType::DoubleArray,
            8 => ObjOrArrayType::ByteArray,
            9 => ObjOrArrayType::ShortArray,
            10 => ObjOrArrayType::IntArray,
            11 => ObjOrArrayType::LongArray,
            _ => panic!("Unknown type num {}", num),
        }
    }
}

// TODO referenced in heapDumper.cpp, but not actually written?
#[allow(unused)]
struct AllocSite {
    is_array: ObjOrArrayType,
    /// May be zero during startup
    class_serial: Serial,
    stack_trace_serial: Serial,
    num_bytes_alive: u32,
    num_instances_alive: u32,
    num_bytes_allocated: u32,
    num_instances_allocated: u32,
}

/// Iterator that parses ids.
pub struct Ids<'a> {
    iter: ParsingIterator<'a, Id, IdSizeParserWrapper<Id>>,
}

impl<'a> Iterator for Ids<'a> {
    type Item = ParseResult<'a, Id>;

    fn next(&mut self) -> Option<Self::Item> {
        self.iter.next()
    }
}

type ParseResult<'e, T> = Result<T, nom::Err<(&'e [u8], nom::error::ErrorKind)>>;

/// Allow iterating over enum variants for enums that have `#[derive(EnumIter)]`.
///
/// Wrapper around `strum`'s `IntoEnumIter` so that users don't need to know about `strum`
pub trait EnumIterable {
    type Iterator: Iterator<Item = Self>;

    fn iter() -> Self::Iterator;
}

impl<T: strum::IntoEnumIterator> EnumIterable for T {
    type Iterator = T::Iterator;

    fn iter() -> Self::Iterator {
        T::iter()
    }
}
