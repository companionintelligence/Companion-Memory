import { Link } from 'react-router-dom';

export interface Content {
  id: string;
  type: 'Web Page' | 'Image' | 'Video' | 'Audio';
  title: string;
  description: string | null;
  url: string;
  mimetype: string | null;
  size: number | null;
  metadata?: Record<string, unknown>;
}

export function generateRichContent(content: Content) {
  return (
    <>
      {content.type == 'Video' && content.url != null && (
        <div
          style={{
            left: 0,
            width: '50%',
            height: 0,
            position: 'relative',
            paddingBottom: '28.125%',
          }}
          className="mt-2"
        >
          {content.mimetype === 'text/html' ? (
            <iframe
              src={content.url as string}
              allowFullScreen={true}
              style={{
                border: 0,
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                position: 'absolute',
              }}
            />
          ) : (
            <video controls>
              <source src={content.url as string} type={content.mimetype as string} />
            </video>
          )}
        </div>
      )}
      {content.type === 'Image' && content?.url != null && (
        <div className="mt-2">
          <img
            src={content.url as string}
            alt={content.description as string}
            className="max-w-1/2 object-cover"
          />
        </div>
      )}
      {content.type === 'Web Page' && content?.url != null && (
        <Link to={content.url} target="_blank">
          <span className="hover:text-blue-600">{content.url as string}</span>
        </Link>
      )}
      {content.type === 'Audio' && content?.url != null && (
        <div
          style={{
            left: 0,
            width: '50%',
            height: 0,
            position: 'relative',
            paddingBottom: '28.125%',
          }}
          className="mt-2"
        >
          {content.mimetype === 'text/html' ? (
            <iframe
              src={content.url as string}
              allowFullScreen={true}
              style={{
                border: 0,
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                position: 'absolute',
              }}
            />
          ) : (
            <audio controls>
              <source src={content.url as string} type={content.mimetype as string} />
            </audio>
          )}
        </div>
      )}
    </>
  );
}
