package com.companionintelligence.app;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.SAXException;

/**
 * DOM access to {@code app/src/main/AndroidManifest.xml}, the hand-maintained one.
 *
 * <p>Uses the JDK's own parser so these assertions cost no dependency and no
 * Android runtime. Namespace-aware on purpose: every interesting attribute is in
 * the {@code android} namespace, and reading them by qualified name would keep
 * passing if someone rebound the prefix.
 */
final class SourceManifest {

    static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";

    private SourceManifest() {}

    static Document parse() {
        File manifest = new File(ProjectFiles.appModuleDir(), "src/main/AndroidManifest.xml");
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            DocumentBuilder builder = factory.newDocumentBuilder();
            return builder.parse(manifest);
        } catch (ParserConfigurationException | SAXException | IOException ex) {
            throw new IllegalStateException("Could not parse " + manifest, ex);
        }
    }

    static Document parseXml(File file) {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            return factory.newDocumentBuilder().parse(file);
        } catch (ParserConfigurationException | SAXException | IOException ex) {
            throw new IllegalStateException("Could not parse " + file, ex);
        }
    }

    /** The value of an {@code android:}-namespaced attribute, or {@code ""} when it is not declared. */
    static String attr(Element element, String name) {
        return element.getAttributeNS(ANDROID_NS, name);
    }

    static List<Element> elements(Document scope, String tagName) {
        return toElements(scope.getElementsByTagName(tagName));
    }

    static List<Element> elements(Element scope, String tagName) {
        return toElements(scope.getElementsByTagName(tagName));
    }

    /** Every {@code android:name} on the {@code tagName} elements found under {@code scope}. */
    static List<String> names(Element scope, String tagName) {
        List<String> names = new ArrayList<>();
        for (Element element : elements(scope, tagName)) {
            names.add(attr(element, "name"));
        }
        return names;
    }

    /** Every {@code <uses-permission android:name>} declared by the app module itself. */
    static List<String> declaredPermissions() {
        List<String> permissions = new ArrayList<>();
        for (Element element : elements(parse(), "uses-permission")) {
            permissions.add(attr(element, "name"));
        }
        return permissions;
    }

    private static List<Element> toElements(NodeList nodes) {
        List<Element> elements = new ArrayList<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Node node = nodes.item(i);
            if (node instanceof Element) {
                elements.add((Element) node);
            }
        }
        return elements;
    }
}
