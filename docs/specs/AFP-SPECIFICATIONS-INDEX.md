# AFP Consortium — Official Specification Index

> **Note:** The AFP Consortium does not allow direct/automated downloads of their PDFs.
> Download each specification manually by visiting https://afpcinc.org/publications/

## Core Standards (required for parser implementation)

| Spec | Code | Title | Direct URL |
|------|------|--------|-----------|
| MO:DCA | AFPC-0004-10 | Mixed Object Document Content Architecture Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/modca-reference-10.pdf |
| PTOCA | AFPC-0009-04 | Presentation Text Object Content Architecture Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/ptoca-reference-04.pdf |
| IOCA | AFPC-0003-09 | Image Object Content Architecture Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/ioca-reference-09.pdf |
| GOCA | AFPC-0008-03 | Graphics Object Content Architecture for AFP Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/afp-goca-reference-03.pdf |
| FOCA | AFPC-0007-06 | Font Object Content Architecture Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/foca-reference-06.pdf |
| BCOCA | AFPC-0005-11 | Bar Code Object Content Architecture Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/bcoca-reference-11.pdf |

## Secondary Standards

| Spec | Code | Title | Direct URL |
|------|------|--------|-----------|
| CMOCA | AFPC-0006-02 | Color Management Object Content Architecture Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/cmoca-reference-02.pdf |
| MOCA | AFPC-0013-02 | Metadata Object Content Architecture Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/moca-reference-02.pdf |
| Line Data | APFC-0010-05 | Programming Guide and Line Data Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/linedata-reference-05.pdf |
| IPDS | AFPC-0001-12 | Intelligent Printer Data Stream Reference | https://afpcinc.org/uploads/1/1/8/4/118458708/ipds-reference-12.pdf |

## IBM Documentation

- IBM i AFP Data Stream: https://www.ibm.com/docs/en/i/7.4.0?topic=streams-advanced-function-presentation-data-stream
- IBM z/OS MO:DCA: https://www.ibm.com/docs/en/zos/2.5.0?topic=streams-mixed-object-document-content-architecture-data

## Key Format Facts (for parser implementation)

### Structured Field Record Format
```
[0x5A] [LENGTH: 2 bytes] [ID: 3 bytes] [FLAGS: 1 byte] [SEQ: 2 bytes] [DATA: variable]
```
- Every record starts with magic byte `0x5A`
- LENGTH does NOT include the leading `0x5A` byte
- ID is a 3-byte type code identifying the structured field type

### Document Hierarchy
```
BDT (Begin Document)
  └── Resource Group (optional, inline resources)
  └── BNG (Begin Named Group)
      └── BPG (Begin Page Group)
          └── BPG (Begin Page)
              ├── BIM (Begin Image)
              ├── BPT (Begin Presentation Text)
              ├── BGR (Begin Graphics)
              └── BBC (Begin Bar Code)
          └── EPG (End Page)
      └── EPG (End Page Group)
  └── BNG (End Named Group)
EDT (End Document)
```

### Sub-Architecture IDs
| Architecture | Purpose | Object Type Code |
|---|---|---|
| PTOCA | Formatted text | BPT/EPT |
| IOCA | Raster/vector images | BIM/EIM |
| GOCA | Vector graphics | BGR/EGR |
| BCOCA | Bar codes | BBC/EBC |
| FOCA | Font definitions | FNC/FNM |

### Measurement Units
- AFP uses **"L-units"** (logical units): typically 1/1440 inch or device-specific
- Coordinates are in L-units from the page origin (top-left)
- Page size specified in the active Form Definition (FormDef resource)

### Key Structured Field Type Codes (hex IDs)
| Code | Abbr | Description |
|---|---|---|
| D3A8A8 | BDT | Begin Document |
| D3A9A8 | EDT | End Document |
| D3A8AD | BPG | Begin Page |
| D3A9AD | EPG | End Page |
| D3A8C5 | BIM | Begin Image |
| D3A8C3 | BGR | Begin Graphics |
| D3A8EB | BBC | Begin Bar Code |
| D3A87B | BPT | Begin Presentation Text |
| D3EEEE | PTD | Presentation Text Descriptor |
| D3EE6B | PTX | Presentation Text Data |
| D3A87E | BFG | Begin Font Resource Group |
| D3A6C3 | OBD | Object Area Descriptor |
| D3ACCE | IDD | Image Data Descriptor |
| D3EE7B | IDE | Image Data |
