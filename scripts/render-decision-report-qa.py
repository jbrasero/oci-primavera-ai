"""Render every page of the synthetic QA report; no source contracts involved."""
import pymupdf

with pymupdf.open('tmp/pdfs/decision-report-qa.pdf') as report:
    print(f'Pages: {len(report)}')
    for index, page in enumerate(report):
        page.get_pixmap(matrix=pymupdf.Matrix(1.3, 1.3)).save(f'tmp/pdfs/decision-report-qa-{index + 1}.png')
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    x0, y0, x1, y1 = span['bbox']
                    assert 0 <= x0 <= x1 <= page.rect.width + 1, span['text']
                    assert 0 <= y0 <= y1 <= page.rect.height + 1, span['text']
    text = ''.join(page.get_text() for page in report)
    for expected in ['Historial de decisiones', 'Compañía de Ferrocarriles', '1250000', 'Publicar contrato e historial']:
        assert expected in text, expected
    print('Text and page bounds verified.')
