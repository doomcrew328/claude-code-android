"""Extract AER ST37 surface-hole and bottom-hole workbooks to compact TSV files.
Usage: python3 -I st37_extract.py <ST37 Excel folder> <out dir>
Data: Alberta Energy Regulator, ST37 List of Wells in Alberta (free public data)."""
import sys, os, csv, openpyxl


def dump(src, dst, cols):
    wb = openpyxl.load_workbook(src, read_only=True)
    ws = wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    hdr = next(it)
    idx = [hdr.index(c) for c in cols]
    n = 0
    with open(dst, 'w', newline='') as fo:
        w = csv.writer(fo, delimiter='\t', lineterminator='\n')
        w.writerow(cols)
        for row in it:
            if row is None or row[idx[0]] is None:
                continue
            w.writerow(['' if row[i] is None else str(row[i]).strip() for i in idx])
            n += 1
    print(os.path.basename(dst), n, flush=True)


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    dump(os.path.join(src, 'ST37_SH.xlsx'), os.path.join(out, 'sh.tsv'),
         ['Well_Licence_Number', 'Licensee', 'Licence_Status', 'Licence_Status_Date', 'Spud_Date', 'Most_Recent_Final_Drill_Date',
          'Energy_Devlpmt_Category_Type', 'SH_Actual_Latitude', 'SH_Actual_Longitude', 'Licence_Surface_Location_Label'])
    dump(os.path.join(src, 'ST37_BH.xlsx'), os.path.join(out, 'bh.tsv'),
         ['Well_UWI', 'Well_Licence_Number', 'Well_Name', 'Final_Drill_Date', 'Final_Total_Depth', 'Max_True_Vertical_Depth',
          'BH_Latitude', 'BH_Longitude'])


if __name__ == '__main__':
    main()
